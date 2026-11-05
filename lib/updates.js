// Keeping Ardite and ffmpeg up to date. yt-dlp updates itself, see ytdlp.js.
import { BIN, DATA, ROOT, VERSION, config } from './config.js';
import { log } from './log.js';
import { isNewer } from './core.js';
import { createUpdater, readRelease } from './updater.js';
import { ffmpegDue, installFfmpeg } from './tools.js';

// isIdle: nothing downloading or waiting to; shutdown: stops Ardite (the update restarts it)
export function createUpdates({ isIdle, shutdown }) {
  // GitHub's "latest release"; updateFeed can point elsewhere (used to test updates)
  const feedUrl = config.updateFeed || `https://api.github.com/repos/${config.repo}/releases/latest`;
  let latest = null; // { version, url, asset }

  const updater = createUpdater({
    root: ROOT,
    data: DATA,
    version: VERSION,
    port: config.port,
    feedUrl,
    log,
    // never restart in the middle of someone's download
    isBusy: () => !isIdle(),
    shutdown,
  });

  // Only asks which release is the latest; installing happens when someone presses "Update now"
  async function checkForUpdate() {
    if (!config.updateCheck || !/^\d+\.\d+\.\d+$/.test(VERSION)) return;
    try {
      const res = await fetch(feedUrl, {
        headers: { 'User-Agent': 'Ardite', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return;
      const release = readRelease(await res.json());
      if (!release) return;
      if (isNewer(release.version, VERSION) && latest?.version !== release.version) {
        log(`New Ardite version available: v${release.version}`);
      }
      latest = release;
    } catch { /* offline, try again later */ }
  }

  // A newer Ardite for the page to offer, or null
  const newRelease = () => (latest && isNewer(latest.version, VERSION)
    ? { version: latest.version, url: latest.url, canInstall: !!latest.asset && updater.supported() }
    : null);

  // About once a month (see tools.js); the files are only swapped while nothing is downloading
  let ffmpegUpdating = false;
  async function updateFfmpeg() {
    if (process.platform !== 'win32' || ffmpegUpdating || !isIdle() || !ffmpegDue(BIN)) return;
    ffmpegUpdating = true;
    log('ffmpeg update: downloading the latest build');
    try {
      const sha256 = await installFfmpeg(BIN, { canReplace: isIdle });
      log(`ffmpeg update: done (sha256 ${sha256.slice(0, 12)}…, verified)`);
    } catch (e) {
      log(`ffmpeg update: ${e.code === 'toolBusy' ? 'postponed, a download is running' : 'failed: ' + e.message}`);
    } finally {
      ffmpegUpdating = false;
    }
  }

  return { updater, checkForUpdate, newRelease, updateFfmpeg };
}
