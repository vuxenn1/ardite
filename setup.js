// Downloads the required tools (yt-dlp, ffmpeg, QR library) into bin/ and public/vendor/.
// Every download is checked against its SHA-256 hash first (see tools.js).
// Usage: node setup.js          -> downloads whatever is missing, updates yt-dlp
//        node setup.js --force  -> downloads everything again
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOURCES, download, installFfmpeg } from './tools.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(ROOT, 'bin');
const VENDOR = path.join(ROOT, 'public', 'vendor');
const FORCE = process.argv.includes('--force');

if (process.platform !== 'win32') {
  console.log('This setup script is for Windows. On Linux/macOS, install yt-dlp and ffmpeg with your package manager and put them in bin/.');
  process.exit(1);
}

const mb = (n) => (n / 1048576).toFixed(1);

// Prints "label: 12.3 MB / 80.0 MB (15%)" on one line while downloading
function progress(label) {
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (now - last < 300) return;
    last = now;
    const pct = total ? ` (${Math.floor((done / total) * 100)}%)` : '';
    process.stdout.write(`\r  ${label}: ${mb(done)} MB${total ? ' / ' + mb(total) + ' MB' : ''}${pct}   `);
  };
}
const ok = (label) => process.stdout.write(`\r  ${label}: downloaded and verified.                    \n`);

async function main() {
  fs.mkdirSync(BIN, { recursive: true });
  fs.mkdirSync(VENDOR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

  console.log('\nArdite setup\n');

  const ytdlp = path.join(BIN, 'yt-dlp.exe');
  if (FORCE || !fs.existsSync(ytdlp)) {
    await download(SOURCES.ytdlp, ytdlp, { onProgress: progress('yt-dlp') });
    ok('yt-dlp');
  } else {
    // yt-dlp checks its own updates against the same checksum list
    console.log('  yt-dlp already installed, updating...');
    try {
      execFileSync(ytdlp, ['-U'], { stdio: 'ignore', timeout: 120000 });
    } catch { /* the current version still works if the update fails */ }
  }

  if (FORCE || !fs.existsSync(path.join(BIN, 'ffmpeg.exe')) || !fs.existsSync(path.join(BIN, 'ffprobe.exe'))) {
    await installFfmpeg(BIN, {
      onProgress: progress('ffmpeg'),
      onExtract: () => process.stdout.write('\r  ffmpeg: verified, extracting...                    '),
    });
    ok('ffmpeg');
  } else {
    console.log('  ffmpeg already installed (Ardite updates it about once a month).');
  }

  const qr = path.join(VENDOR, 'qrcode.js');
  if (FORCE || !fs.existsSync(qr)) {
    try {
      await download(SOURCES.qrcode, qr);
      ok('QR library');
    } catch (e) {
      console.log('  Could not download the QR library (not critical, only the QR code will be missing): ' + e.message);
    }
  }

  const version = execFileSync(ytdlp, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`\n  Ready! yt-dlp ${version}\n`);
}

main().catch((e) => {
  console.error('\nSetup error: ' + e.message);
  process.exit(1);
});
