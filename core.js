// Pure helpers used by the server: no network, no files, no state.
// Kept apart from server.js so they can be tested (see test/).
import { summarizeSubs, parseSubsOption } from './subs.js';

export function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Turns yt-dlp errors into short, human-readable messages.
// "code" lets the web UI show the message in the viewer's language.
export function friendlyError(raw) {
  const msg = (raw || '').replace(/^ERROR:\s*/, '').trim();
  const rules = [
    [/Unsupported URL/i, 'unsupported', 'This site or link isn\'t supported.'],
    [/Sign in to confirm (your age|you.re not a bot)/i, 'signin', 'YouTube wants you to sign in. Adding cookies should fix it (see README.md).'],
    [/private video|This video is private/i, 'private', 'This video is private.'],
    [/login required|requires? (a )?log ?in|rate-limit reached|cookies/i, 'login', 'This content requires login. Adding cookies should fix it (see README.md).'],
    [/Requested format is not available/i, 'format', 'That quality isn\'t available for this video. Try another one.'],
    [/Video unavailable|not available|has been removed|404/i, 'notFound', 'Video not found or removed.'],
    [/Unable to download webpage|getaddrinfo|timed out|Connection/i, 'network', 'Couldn\'t reach the site. Check your internet connection.'],
    [/No video formats found|There is no video in this post|No video could be found/i, 'noVideo', 'No downloadable video found at this link.'],
    [/Not found/i, 'notFound', 'Video not found or removed.'],
  ];
  for (const [re, code, text] of rules) if (re.test(msg)) return { code, message: text, detail: msg };
  return { code: 'failed', message: 'Download failed.', detail: msg || 'Unknown error' };
}

export const fail = (code, message) => ({ code, message });

export function lastError(stderr) {
  const lines = stderr.split(/\r?\n/).filter((l) => l.startsWith('ERROR:'));
  return lines.length ? lines[lines.length - 1] : stderr.trim().split(/\r?\n/).pop();
}

export function bestThumb(thumbs) {
  if (!Array.isArray(thumbs) || !thumbs.length) return null;
  const sized = thumbs.filter((t) => t.url && t.width);
  if (sized.length) return sized.reduce((a, b) => (b.width > a.width ? b : a)).url;
  return thumbs.filter((t) => t.url).pop()?.url || null;
}

export const isVideoFormat = (f) => (f.vcodec && f.vcodec !== 'none') || (!f.vcodec && f.height);

// "res" in yt-dlp is the smaller side, so vertical 1080x1920 counts as 1080p
export const shortSide = (w, h) => Math.min(h || 0, w || h || 0) || h || 0;

export function summarizeVideo(info) {
  const heights = new Set();
  const fps = {}; // highest frame rate per resolution, e.g. { 1080: 60 }
  let hasVideo = false;
  for (const f of info.formats || []) {
    if (isVideoFormat(f)) {
      hasVideo = true;
      const h = shortSide(f.width, f.height);
      if (h) {
        heights.add(h);
        if (f.fps) fps[h] = Math.max(fps[h] || 0, Math.round(f.fps));
      }
    }
  }
  if (!info.formats?.length) hasVideo = !!(info.height || info.vcodec !== 'none');
  return {
    fps,
    type: 'video',
    title: info.title || info.id,
    uploader: info.uploader || info.channel || info.creator || null,
    duration: info.duration || null,
    thumbnail: info.thumbnail || bestThumb(info.thumbnails),
    site: info.extractor_key || info.extractor || null,
    heights: [...heights].filter((h) => h >= 144).sort((a, b) => b - a),
    hasVideo,
    subs: summarizeSubs(info),
  };
}

export function entryUrl(e) {
  if (isValidUrl(e.url)) return e.url;
  if (isValidUrl(e.webpage_url)) return e.webpage_url;
  if (e.id && /youtube/i.test(e.ie_key || '')) return `https://www.youtube.com/watch?v=${e.id}`;
  return null;
}

export function summarizePlaylist(info, maxItems = 500) {
  const entries = [];
  for (const [i, e] of (info.entries || []).entries()) {
    if (!e) continue;
    const url = entryUrl(e);
    if (!url) continue;
    const title = e.title || e.id || url;
    entries.push({
      index: i + 1,
      url,
      title,
      duration: e.duration || null,
      thumbnail: bestThumb(e.thumbnails) || e.thumbnail || null,
      // private/deleted videos and nested playlists (e.g. channel tabs) can't be downloaded as one file
      unavailable: /^\[(private|deleted|unavailable)( video)?\]$/i.test(title)
        || e._type === 'playlist' || /Tab$/.test(e.ie_key || ''),
    });
  }
  return {
    type: 'playlist',
    title: info.title || 'Playlist',
    uploader: info.uploader || info.channel || null,
    site: info.extractor_key || info.extractor || null,
    count: entries.length,
    thumbnail: entries.find((e) => !e.unavailable && e.thumbnail)?.thumbnail || bestThumb(info.thumbnails),
    entries: entries.slice(0, maxItems),
    truncated: entries.length > maxItems,
  };
}

// Best resolution on offer, used to notice when a site hands out a lower quality than usual
export function videoStats(info) {
  let maxAll = 0;
  let maxH264 = 0;
  for (const f of info.formats || []) {
    if (!isVideoFormat(f)) continue;
    const h = shortSide(f.width, f.height);
    maxAll = Math.max(maxAll, h);
    if (/^(avc|h264)/i.test(f.vcodec || '')) maxH264 = Math.max(maxH264, h);
  }
  return { maxAll, maxH264 };
}

// Links like youtube.com/watch?v=X&list=Y are both a video and a playlist
export function linkKind(url) {
  const u = new URL(url);
  const list = u.searchParams.has('list') || /\/(playlist|sets|album)s?\b/i.test(u.pathname);
  const video = u.searchParams.has('v') || /(^|\.)youtu\.be$/i.test(u.hostname) || /\/shorts\//.test(u.pathname);
  return { list, video };
}

export const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'wav', 'best'];

// The resolution the chosen settings should give, if the preview told us what's on offer
export function expectedHeight(opts, stats) {
  if (!stats || opts.mode === 'audio') return null;
  const cap = opts.quality === 'max' ? Infinity : Number(opts.quality);
  const best = opts.codec === 'h264' && opts.quality === 'max' ? stats.maxH264 || stats.maxAll : stats.maxAll;
  const h = Math.min(cap, best);
  return h > 0 && Number.isFinite(h) ? h : null;
}

export const CODEC_NAMES = [[/^av0?1/i, 'AV1'], [/^vp0?9/i, 'VP9'], [/^(avc|h264)/i, 'H.264'], [/^(hev|hvc|h265)/i, 'H.265'], [/^vp0?8/i, 'VP8']];

export const codecName = (c) => CODEC_NAMES.find(([re]) => re.test(c))?.[1] || String(c).split('.')[0].toUpperCase();

export function parseOptions(body) {
  return {
    mode: body.mode === 'audio' ? 'audio' : 'video',
    quality: /^\d{3,4}$/.test(String(body.quality)) ? String(body.quality) : 'max',
    codec: body.codec === 'best' ? 'best' : 'h264',
    audioFormat: AUDIO_FORMATS.includes(body.audioFormat) ? body.audioFormat : 'mp3',
    trim: null,
    // subtitles only make sense for videos
    subs: body.mode === 'audio' ? null : parseSubsOption(body.subs),
  };
}

// { start, end, precise } in seconds; end null means "to the end". undefined = invalid.
export function parseTrim(t) {
  if (t == null) return null;
  if (typeof t !== 'object') return undefined;
  const start = t.start == null || t.start === '' ? 0 : Number(t.start);
  const end = t.end == null || t.end === '' ? null : Number(t.end);
  const ok = (n) => Number.isFinite(n) && n >= 0 && n <= 48 * 3600;
  if (!ok(start) || (end != null && (!ok(end) || end <= start))) return undefined;
  if (start === 0 && end == null) return null;
  const round = (n) => Math.round(n * 1000) / 1000;
  return { start: round(start), end: end == null ? null : round(end), precise: t.precise === true };
}

// 83 -> "1m23s" for file names (":" isn't allowed in Windows file names)
export function fileClock(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}h${pad(m)}m${pad(s % 60)}s` : `${m}m${pad(s % 60)}s`;
}

export function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Download file name header: a plain ASCII fallback plus the real (UTF-8) name.
// encodeURIComponent leaves ' ( ) * alone, but they aren't allowed in filename*, so those are encoded too.
export function contentDisposition(name) {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'download';
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
