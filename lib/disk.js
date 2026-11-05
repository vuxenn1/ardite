// Free space where downloads wait (see lowOnSpace in core.js for the rules)
import fs from 'node:fs';
import { config, WORK } from './config.js';
import { fail, lowOnSpace } from './core.js';

export const MIN_FREE = Math.max(0.5, Number(config.minFreeGB) || 2) * 1024 ** 3;

export function freeSpace() {
  try {
    const s = fs.statfsSync(WORK);
    return s.bavail * s.bsize;
  } catch {
    return Infinity; // unknown
  }
}

export const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;

export const diskFull = (free) => ({ ...fail('diskFull', 'Not enough free disk space on the PC.'), detail: `${gb(free)} free` });

export function diskStatus() {
  const free = freeSpace();
  return { free: Number.isFinite(free) ? free : null, min: MIN_FREE, low: lowOnSpace(free, MIN_FREE, { starting: true }) };
}
