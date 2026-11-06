// Starting and stopping the tools Ardite runs (yt-dlp, ffmpeg) so that a stop reaches everything
// they started too. yt-dlp starts ffmpeg itself, and stopping only yt-dlp would leave it running.
import { execFile } from 'node:child_process';

// Spawn options for a tool. Outside Windows the tool gets its own process group, so killTree can
// stop the whole group at once.
export const TOOL_SPAWN = Object.freeze({ windowsHide: true, detached: process.platform !== 'win32' });

// Stops a tool and everything it started
export function killTree(proc) {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-proc.pid, 'SIGKILL'); // the group (see TOOL_SPAWN)
  } catch {
    proc.kill('SIGKILL'); // started without a group of its own
  }
}
