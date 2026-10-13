// Gerekli araçları (yt-dlp, ffmpeg, QR kütüphanesi) bin/ ve public/vendor/ altına indirir.
// Kullanım: node setup.js          → eksik olanları indirir
//           node setup.js --force  → hepsini yeniden indirir
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(ROOT, 'bin');
const VENDOR = path.join(ROOT, 'public', 'vendor');
const FORCE = process.argv.includes('--force');

if (process.platform !== 'win32') {
  console.log('Bu kurulum scripti Windows için. Linux/macOS\'ta yt-dlp ve ffmpeg\'i paket yöneticisiyle kurup bin/ klasörüne koyman yeterli.');
  process.exit(1);
}

const SOURCES = {
  ytdlp: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  ffmpeg: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  qrcode: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
};

const mb = (n) => (n / 1048576).toFixed(1);

async function download(url, dest, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label} indirilemedi: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    const now = Date.now();
    if (now - last > 300) {
      last = now;
      const pct = total ? ` (%${Math.floor((done / total) * 100)})` : '';
      process.stdout.write(`\r  ${label}: ${mb(done)} MB${total ? ' / ' + mb(total) + ' MB' : ''}${pct}   `);
    }
  });
  const tmp = dest + '.part';
  await pipeline(body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  process.stdout.write(`\r  ${label}: ${mb(done)} MB indirildi.                    \n`);
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name) {
      return p;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(BIN, { recursive: true });
  fs.mkdirSync(VENDOR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

  console.log('\nArdite kurulumu\n');

  const ytdlp = path.join(BIN, 'yt-dlp.exe');
  if (FORCE || !fs.existsSync(ytdlp)) {
    await download(SOURCES.ytdlp, ytdlp, 'yt-dlp');
  } else {
    console.log('  yt-dlp zaten var, güncelleniyor...');
    try {
      execFileSync(ytdlp, ['-U'], { stdio: 'ignore', timeout: 120000 });
    } catch { /* güncelleme başarısız olsa da mevcut sürüm çalışır */ }
  }

  const ffmpeg = path.join(BIN, 'ffmpeg.exe');
  const ffprobe = path.join(BIN, 'ffprobe.exe');
  if (FORCE || !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-ffmpeg-'));
    try {
      const zip = path.join(work, 'ffmpeg.zip');
      await download(SOURCES.ffmpeg, zip, 'ffmpeg');
      console.log('  ffmpeg arşivden çıkarılıyor...');
      // Windows 10+ ile gelen tar.exe zip dosyalarını açabiliyor
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      execFileSync(tar, ['-xf', zip, '-C', work], { stdio: 'ignore' });
      for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
        const src = findFile(work, name);
        if (!src) throw new Error(`Arşivde ${name} bulunamadı`);
        fs.copyFileSync(src, path.join(BIN, name));
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  } else {
    console.log('  ffmpeg zaten var.');
  }

  const qr = path.join(VENDOR, 'qrcode.js');
  if (FORCE || !fs.existsSync(qr)) {
    try {
      await download(SOURCES.qrcode, qr, 'QR kütüphanesi');
    } catch (e) {
      console.log('  QR kütüphanesi indirilemedi (önemli değil, sadece QR kod gösterilmez): ' + e.message);
    }
  }

  const version = execFileSync(ytdlp, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`\n  Hazır! yt-dlp ${version}\n`);
}

main().catch((e) => {
  console.error('\nKurulum hatası: ' + e.message);
  process.exit(1);
});
