// A stand-in for yt-dlp used by the server and browser tests: no internet, the link says what to do.
//   https://fake.test/<id>?ms=<how long>&size=<file bytes>&total=<bytes it claims>&fail=<error>&flaky=1
//                         &chatty=1 (a progress line every few milliseconds, like a fast download)
//   https://fake.test/list/<id>?n=<items>   a playlist (with --yes-playlist)
// It speaks just enough of yt-dlp's language for the server: -J (info), downloads with the
// progress lines Ardite asks for, --version and --update-to stable|nightly@latest.
// Every call is noted in FAKE_YTDLP_STATE/calls.log.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => args[args.indexOf(flag) + 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = process.env.FAKE_YTDLP_STATE;
const note = (line) => STATE && fs.appendFileSync(path.join(STATE, 'calls.log'), `${Date.now()} ${line}\n`);

const ERRORS = {
  format: 'Requested format is not available. Use --list-formats for a list of available formats',
  private: '[youtube] x: Private video. Sign in if you\'ve been granted access to this video',
};
const fail = (error) => {
  process.stderr.write(`ERROR: ${error}\n`);
  process.exit(1);
};

// The channel it's on (stable unless switched), kept between runs like the real .exe does
const channelFile = STATE && path.join(STATE, 'channel');
const channel = (channelFile && fs.existsSync(channelFile) && fs.readFileSync(channelFile, 'utf8')) || 'stable';
const VERSIONS = { stable: '2099.01.01', nightly: '2099.01.02.000000' };

if (has('--version')) {
  console.log(VERSIONS[channel]);
  process.exit(0);
}
if (has('--update-to')) {
  note('update');
  const wanted = value('--update-to').split('@')[0];
  if (wanted === channel) {
    console.log(`yt-dlp is up to date (${channel}@${VERSIONS[channel]} from fake)`);
  } else {
    if (channelFile) fs.writeFileSync(channelFile, wanted);
    console.log(`Updated yt-dlp to ${wanted}@${VERSIONS[wanted]} from fake`);
  }
  process.exit(0);
}

const url = new URL(has('--load-info-json')
  ? JSON.parse(fs.readFileSync(value('--load-info-json'), 'utf8')).webpage_url
  : args[args.indexOf('--') + 1]);
const q = (key, fallback) => url.searchParams.get(key) ?? fallback;
const id = url.pathname.split('/').filter(Boolean).pop() || 'x';
const title = `Video ${id}`;

// ---------- -J: info for the preview ----------
if (has('-J')) {
  note(`info-start ${id}`);
  await sleep(Number(q('ms', 0)));
  note(`info-end ${id}`);
  if (q('fail')) fail(ERRORS[q('fail')] || q('fail'));
  if (url.pathname.startsWith('/list/') && has('--yes-playlist')) {
    const entries = Array.from({ length: Number(q('n', 3)) }, (_, i) => ({
      _type: 'url', id: `${id}-${i + 1}`, title: `Item ${i + 1}`, duration: 60,
      url: `https://fake.test/${id}-${i + 1}`,
    }));
    console.log(JSON.stringify({ _type: 'playlist', id, title: `List ${id}`, extractor_key: 'Fake', entries }));
  } else {
    console.log(JSON.stringify({
      id, title, duration: 60, extractor_key: 'Fake', webpage_url: url.href,
      formats: [{ format_id: 'v', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 1080, fps: 30 }],
    }));
  }
  process.exit(0);
}

// ---------- a download ----------
note(`download-start ${id}`);

// flaky=1: the first try gets the 403 YouTube sometimes answers with, the next one works
const tries = STATE ? path.join(STATE, `tries-${id}`) : null;
const attempt = tries ? Number(fs.existsSync(tries) ? fs.readFileSync(tries, 'utf8') : 0) + 1 : 1;
if (tries) fs.writeFileSync(tries, String(attempt));
if (q('flaky') && attempt === 1) fail('unable to download video data: HTTP Error 403: Forbidden');
if (q('fail')) fail(ERRORS[q('fail')] || q('fail'));

const size = Number(q('size', 1000));
const claimed = Number(q('total', size)); // what it says it will download (a lie can test the disk check)
const ms = Number(q('ms', 0));
// chatty: a burst of lines every 5 ms, so lines keep arriving while the server stops the program
const chatty = !!q('chatty');
const steps = Math.max(1, Math.round(ms / (chatty ? 5 : 100)));
const burst = chatty ? 20 : 1;
for (let i = 1; i <= steps; i++) {
  const line = `ARDITE|${Math.round((claimed * i) / steps)}|${claimed}|NA|1000000|1|avc1.640028|mp4a.40.2\n`;
  process.stdout.write(line.repeat(burst));
  await sleep(ms / steps);
}

const out = value('-o').replace(/%\(title\)\.\d+B/, title).replace('%(id)s', id).replace('%(ext)s', 'mp4');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.alloc(size, 'v'));
console.log(`ARDITE_DONE|1920|1080|30|avc1.640028|mp4a.40.2|SDR|${title}`);
console.log('ARDITE_META|60.4|Fake|Fake channel | with a bar');
note(`download-end ${id}`);
