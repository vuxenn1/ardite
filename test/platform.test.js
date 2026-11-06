import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { toolTarget, ytdlpSource, ffmpegSource } from '../lib/tools.js';
import { packageName } from '../lib/updater.js';
import { firefoxProfileRoots } from '../lib/login.js';
import { windowsRunCommand, systemdUnit, launchAgent } from '../lib/autostart.js';
import { pidFromNetstat } from '../lib/service.js';

test('toolTarget picks the yt-dlp and ffmpeg builds for each system', () => {
  assert.deepEqual(toolTarget('win32', 'x64'), { ytdlp: 'yt-dlp.exe', ffmpeg: 'ffmpeg-master-latest-win64-gpl.zip' });
  assert.deepEqual(toolTarget('win32', 'arm64'), { ytdlp: 'yt-dlp_arm64.exe', ffmpeg: 'ffmpeg-master-latest-winarm64-gpl.zip' });
  assert.deepEqual(toolTarget('linux', 'x64', false), { ytdlp: 'yt-dlp_linux', ffmpeg: 'ffmpeg-master-latest-linux64-gpl.tar.xz' });
  assert.deepEqual(toolTarget('linux', 'arm64', false), { ytdlp: 'yt-dlp_linux_aarch64', ffmpeg: 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz' });
  assert.equal(toolTarget('linux', 'x64', true).ytdlp, 'yt-dlp_musllinux'); // Alpine
  assert.equal(toolTarget('linux', 'arm64', true).ytdlp, 'yt-dlp_musllinux_aarch64');
  assert.deepEqual(toolTarget('darwin', 'arm64'), { ytdlp: 'yt-dlp_macos', ffmpeg: null }); // ffmpeg from Homebrew
  assert.equal(toolTarget('linux', 'ia32', false), null);
  assert.equal(toolTarget('freebsd', 'x64'), null);
});

test('the download links point at the builds and their checksum lists', () => {
  const linux = toolTarget('linux', 'x64', false);
  assert.equal(ytdlpSource(linux).url, 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
  assert.match(ytdlpSource(linux).sums, /SHA2-256SUMS$/);
  assert.equal(ffmpegSource(linux).url, 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz');
  assert.equal(ffmpegSource(toolTarget('darwin', 'x64')), null);
  assert.equal(ffmpegSource(null), null);
});

test('packageName: the release package for each system', () => {
  assert.equal(packageName('win32', 'x64'), 'Ardite-win64.zip');
  assert.equal(packageName('win32', 'arm64'), 'Ardite-win64.zip');
  assert.equal(packageName('linux', 'x64'), 'Ardite-linux-x64.tar.gz');
  assert.equal(packageName('linux', 'arm64'), 'Ardite-linux-arm64.tar.gz');
  assert.equal(packageName('darwin', 'arm64'), 'Ardite-macos-arm64.tar.gz');
  assert.equal(packageName('linux', 'ia32'), null);
});

test('firefoxProfileRoots knows where each system keeps Firefox profiles', () => {
  const home = path.join(path.sep, 'home', 'me');
  const linux = firefoxProfileRoots('linux', {}, home);
  assert.ok(linux.includes(path.join(home, '.mozilla', 'firefox')));
  assert.ok(linux.some((p) => p.includes('snap')));
  assert.ok(linux.some((p) => p.includes('org.mozilla.firefox')));
  assert.deepEqual(firefoxProfileRoots('darwin', {}, home), [path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')]);
  const win = firefoxProfileRoots('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: path.join(home, 'nothing-here') }, home);
  assert.equal(win[0], path.join('C:\\Users\\me\\AppData\\Roaming', 'Mozilla', 'Firefox', 'Profiles'));
});

test('autostart entries run the server from the Ardite folder', () => {
  assert.equal(windowsRunCommand('C:\\Apps\\My Ardite', 'C:\\Windows'),
    '"C:\\Windows\\System32\\wscript.exe" "C:\\Apps\\My Ardite\\scripts\\start-hidden.vbs"');

  const unit = systemdUnit('/home/me/Ardite 2', '/home/me/Ardite 2/runtime/node');
  assert.match(unit, /^WorkingDirectory="\/home\/me\/Ardite 2"$/m);
  assert.match(unit, /^ExecStart="\/home\/me\/Ardite 2\/runtime\/node" "\/home\/me\/Ardite 2\/server.js"$/m);
  // an update started by the server must outlive it
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /^WantedBy=default.target$/m);
  assert.match(systemdUnit('/opt/a%b', '/usr/bin/node'), /WorkingDirectory="\/opt\/a%%b"/);

  const plist = launchAgent('/Users/me/A&B', '/usr/local/bin/node');
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/Users\/me\/A&amp;B\/server.js<\/string>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test('pidFromNetstat finds the program listening on a port', () => {
  const out = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100',
    '  TCP    0.0.0.0:17878          0.0.0.0:0              LISTENING       2222',
    '  TCP    127.0.0.1:7878         127.0.0.1:50000        ESTABLISHED     3333',
    '  TCP    0.0.0.0:7878           0.0.0.0:0              LISTENING       4444',
  ].join('\r\n');
  assert.equal(pidFromNetstat(out, 7878), 4444);
  assert.equal(pidFromNetstat(out, 9999), null);
});
