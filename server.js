// Ardite: a self-hosted video downloader for your home network.
// Downloads with yt-dlp into a temp folder, then streams the file to whichever
// device made the request (the PC itself or a phone on the same Wi-Fi).
// The parts live in lib/; this file starts them and ties them together.
import http from 'node:http';
import fs from 'node:fs';
import { config, YTDLP, WORK } from './lib/config.js';
import { log } from './lib/log.js';
import { lanAddresses } from './lib/network.js';
import { useYtdlpHooks, readVersion, requestYtdlpUpdate } from './lib/ytdlp.js';
import { infoBusy, dropStaleInfo } from './lib/info.js';
import { idle, jobsRunning, pump, stopAllJobs } from './lib/jobs.js';
import { createUpdates } from './lib/updates.js';
import { createRoutes } from './lib/routes.js';
import { listHistory } from './lib/history.js';
import { seedStats } from './lib/stats.js';

if (!fs.existsSync(YTDLP)) {
  console.error('yt-dlp not found. Run the setup first: node setup.js');
  process.exit(1);
}

// yt-dlp replaces itself only while no download or preview uses it; queued downloads go on afterwards
// statistics start with the downloads already in the history (only the first time)
seedStats(listHistory());

useYtdlpHooks({ isFree: () => !jobsRunning() && !infoBusy(), afterUpdate: pump });

const updates = createUpdates({ isIdle: idle, shutdown });
const server = http.createServer(createRoutes({ updates }));

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`Port ${config.port} is in use. Ardite is probably already running.`);
    process.exit(0);
  }
  throw e;
});

const HOURS_12 = 12 * 60 * 60 * 1000;

server.listen(config.port, config.host, () => {
  log(`Ardite is running at http://localhost:${config.port}`);
  for (const ip of lanAddresses()) log(`  On your phone: http://${ip}:${config.port}`);
  readVersion();
  setTimeout(() => requestYtdlpUpdate('at start'), 5000);
  setInterval(() => requestYtdlpUpdate('twice a day'), HOURS_12);
  setTimeout(updates.updateFfmpeg, 10 * 60 * 1000);
  setInterval(updates.updateFfmpeg, HOURS_12);
  setTimeout(updates.checkForUpdate, 8000);
  setInterval(updates.checkForUpdate, HOURS_12);
  setInterval(dropStaleInfo, 60000);
});

function shutdown() {
  stopAllJobs();
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
