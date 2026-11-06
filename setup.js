// Downloads the required tools (yt-dlp, ffmpeg, QR library) into bin/ and public/vendor/, in the
// builds for this system. Every download is checked against its SHA-256 hash first (see tools.js).
// `ardite install` and updates run this; it can also be run by itself:
//   node setup.js          -> downloads whatever is missing, updates yt-dlp
//   node setup.js --force  -> downloads everything again
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  toolTarget, ytdlpSource, QRCODE_SOURCE, download, installFfmpeg, removeLeftovers,
} from './lib/tools.js';
import { readJson, EXE, FFMPEG } from './lib/config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(ROOT, 'bin');
const VENDOR = path.join(ROOT, 'public', 'vendor');
const FORCE = process.argv.includes('--force');

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

  // files older versions left behind (see LEFTOVERS in lib/tools.js)
  const removed = removeLeftovers(ROOT);
  if (removed.length) console.log(`  Removed files older versions left behind: ${removed.join(', ')}`);

  const target = toolTarget();
  const ytdlp = path.join(BIN, 'yt-dlp' + EXE);
  if (!target && !fs.existsSync(ytdlp)) {
    console.log(`  There are no ready-made yt-dlp and ffmpeg builds for this system (${process.platform} ${process.arch}).`);
    console.log(`  Put yt-dlp and ffmpeg (with ffprobe) into ${BIN} yourself, then run this again.`);
    process.exit(1);
  }

  if (FORCE || !fs.existsSync(ytdlp)) {
    await download(ytdlpSource(target), ytdlp, { onProgress: progress('yt-dlp') });
    if (process.platform !== 'win32') fs.chmodSync(ytdlp, 0o755);
    ok('yt-dlp');
  } else {
    // yt-dlp checks its own updates against the same checksum list. It follows the channel picked
    // in Settings (stable or nightly); "@latest" also lets it go back from nightly to stable.
    const channel = readJson(path.join(ROOT, 'data', 'config.json')).ytdlpChannel === 'nightly' ? 'nightly' : 'stable';
    console.log(`  yt-dlp already installed, updating (${channel})...`);
    try {
      execFileSync(ytdlp, ['--update-to', `${channel}@latest`], { stdio: 'ignore', timeout: 120000 });
    } catch { /* the current version still works if the update fails */ }
  }

  const ffmpegHere = fs.existsSync(path.join(BIN, 'ffmpeg' + EXE)) && fs.existsSync(path.join(BIN, 'ffprobe' + EXE));
  if (target?.ffmpeg && (FORCE || !ffmpegHere)) {
    await installFfmpeg(BIN, {
      target,
      onProgress: progress('ffmpeg'),
      onExtract: () => process.stdout.write('\r  ffmpeg: verified, extracting...                    '),
    });
    ok('ffmpeg');
  } else if (ffmpegHere) {
    console.log('  ffmpeg already installed (Ardite updates it about once a month).');
  } else if (fs.existsSync(FFMPEG)) {
    console.log(`  Using the ffmpeg installed on this system (${path.dirname(FFMPEG)}).`);
  } else {
    console.log('  ffmpeg is missing. Ardite works without it, but can\'t join the best video with its sound,');
    console.log(process.platform === 'darwin'
      ? '  make GIFs or add subtitles. Install it with Homebrew: brew install ffmpeg'
      : `  make GIFs or add subtitles. Put ffmpeg and ffprobe into ${BIN}.`);
  }

  const qr = path.join(VENDOR, 'qrcode.js');
  if (FORCE || !fs.existsSync(qr)) {
    try {
      await download(QRCODE_SOURCE, qr);
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
