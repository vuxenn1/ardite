// Minimal streaming ZIP writer (store only — videos don't compress further).
// Sizes and CRCs are computed up front so the exact Content-Length is known
// and no data descriptors are needed. Supports ZIP64 for >4 GB archives.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const MAX32 = 0xffffffff;

export async function fileCrc32(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file)) crc = zlib.crc32(chunk, crc);
  return crc >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * @param {{ name: string, path: string, size: number, crc: number }[]} entries
 * @returns {{ length: number, stream: Readable }}
 */
export function createZip(entries) {
  const { time, date } = dosDateTime();
  const parts = []; // Buffers and { path } placeholders, in order
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const big = e.size >= MAX32;

    const localExtra = big ? Buffer.alloc(20) : Buffer.alloc(0);
    if (big) {
      localExtra.writeUInt16LE(0x0001, 0);
      localExtra.writeUInt16LE(16, 2);
      localExtra.writeBigUInt64LE(BigInt(e.size), 4);
      localExtra.writeBigUInt64LE(BigInt(e.size), 12);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(big ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(big ? MAX32 : e.size, 18);
    local.writeUInt32LE(big ? MAX32 : e.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);

    const header = Buffer.concat([local, name, localExtra]);
    parts.push(header, { path: e.path, size: e.size });

    const farOffset = offset >= MAX32;
    const extraFields = [];
    if (big) extraFields.push(BigInt(e.size), BigInt(e.size));
    if (farOffset) extraFields.push(BigInt(offset));
    const centralExtra = Buffer.alloc(extraFields.length ? 4 + extraFields.length * 8 : 0);
    if (extraFields.length) {
      centralExtra.writeUInt16LE(0x0001, 0);
      centralExtra.writeUInt16LE(extraFields.length * 8, 2);
      extraFields.forEach((v, i) => centralExtra.writeBigUInt64LE(v, 4 + i * 8));
    }

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(45, 4);
    cd.writeUInt16LE(big || farOffset ? 45 : 20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(big ? MAX32 : e.size, 20);
    cd.writeUInt32LE(big ? MAX32 : e.size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(centralExtra.length, 30);
    cd.writeUInt32LE(farOffset ? MAX32 : offset, 42);
    central.push(Buffer.concat([cd, name, centralExtra]));

    offset += header.length + e.size;
  }

  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  const needZip64 = cdOffset >= MAX32 || cdBuf.length >= MAX32 || entries.length >= 0xffff
    || entries.some((e) => e.size >= MAX32);

  const tail = [cdBuf];
  if (needZip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdBuf.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(entries.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
  end.writeUInt32LE(Math.min(cdBuf.length, MAX32), 12);
  end.writeUInt32LE(needZip64 ? MAX32 : cdOffset, 16);
  tail.push(end);
  parts.push(...tail);

  const length = parts.reduce((n, p) => n + (Buffer.isBuffer(p) ? p.length : p.size), 0);
  const stream = Readable.from((async function* () {
    for (const p of parts) {
      if (Buffer.isBuffer(p)) yield p;
      else for await (const chunk of fs.createReadStream(p.path)) yield chunk;
    }
  })());
  return { length, stream };
}
