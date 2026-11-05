// Small HTTP helpers: JSON answers, reading request bodies, serving files and the page.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { PUBLIC } from './config.js';
import { contentDisposition } from './core.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// The request body as text; rejects past the limit
export function readText(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8'); // keeps multi-byte characters intact across chunks
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
  });
}

export async function readBody(req) {
  const text = await readText(req);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error('bad json');
  }
}

// A finished download (or one of its .srt files), with support for resuming (Range)
export function serveFile(req, res, file) {
  if (!file || !fs.existsSync(file.path)) return sendText(res, 404, 'File not found or expired.');
  const size = fs.statSync(file.path).size;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(file.name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (start >= size || start < 0 || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return pipeline(fs.createReadStream(file.path, { start, end }), res, () => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  pipeline(fs.createReadStream(file.path), res, () => {});
}

// A ZIP built by zip.js: its exact length is known up front
export function sendZip(res, name, { length, stream }) {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition(name),
    'Content-Length': length,
    'Cache-Control': 'no-store',
  });
  // pipeline() closes the files if the client aborts or a read fails
  pipeline(stream, res, () => {});
}

// The web page and its files from public/
export function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// Server-sent events: the current state right away, then every change until the target is done.
// target.listeners holds the open responses.
export function openEvents(req, res, target, snapshot, final) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  if (final) return res.end();
  target.listeners.add(res);
  req.on('close', () => target.listeners.delete(res));
}
