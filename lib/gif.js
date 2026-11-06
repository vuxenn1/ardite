// Turning a short downloaded part into an animated GIF with ffmpeg. A palette is made from the
// part itself first, so colors stay close to the video instead of the usual washed-out GIF look.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const GIF_FPS = 12; // smooth enough for a GIF, and keeps the file small

export function gifArgs(input, output, width) {
  // fewer frames, never wider than the video itself (the height follows), then the picture is
  // split: one copy makes the palette, the other is drawn with it
  const filter = `fps=${GIF_FPS},scale=w='min(iw,${width})':h=-1:flags=lanczos,split[a][b];`
    + '[a]palettegen=max_colors=192:stats_mode=diff[p];'
    + '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  return ['-v', 'error', '-y', '-i', input, '-vf', filter, '-loop', '0', output];
}

// Makes `output` from `input`; onSpawn gets the ffmpeg process so a cancel can stop it
export function makeGif(ffmpeg, input, output, width, onSpawn) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, gifArgs(input, output, width), { windowsHide: true });
    onSpawn?.(proc);
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => (err += e.message));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(output)) return resolve();
      fs.rmSync(output, { force: true });
      reject(new Error(err.trim().split(/\r?\n/).pop() || `ffmpeg exited with ${code}`));
    });
  });
}
