// Everything the web page asks the server for (/api/...), and the page itself.
import { VERSION, config } from './config.js';
import { log } from './log.js';
import { isValidUrl, fail, parseOptions, parseTrim } from './core.js';
import { sendJson, sendText, readText, readBody, serveFile, sendZip, serveStatic, openEvents } from './http.js';
import { refuseForeign, signedIn, pinOn, handlePin } from './access.js';
import { lanAddresses, deviceOf } from './network.js';
import { cookiesFileOk, ytdlpVersion, ytdlpStatus, requestYtdlpUpdate } from './ytdlp.js';
import { diskStatus } from './disk.js';
import { getInfo } from './info.js';
import { listHistory, removeHistory, clearHistory } from './history.js';
import { loginStatus, saveCookiesFile, removeCookiesFile, setLoginBrowser, testLogin } from './login.js';
import {
  isFinal, getJob, getBatch, publicJob, publicBatch, createJob, createBatch, deleteJob, removeBatch, batchZip,
} from './jobs.js';

// The route handlers below return true when they answered the request
const json = (res, status, data) => (sendJson(res, status, data), true);
const handled = () => true;

// updates: see updates.js
export function createRoutes({ updates }) {
  function status(req, res) {
    // locked devices only learn that this is Ardite and that it wants the PIN
    if (!signedIn(req)) return sendJson(res, 200, { name: 'Ardite', version: VERSION, locked: true });
    sendJson(res, 200, {
      name: 'Ardite',
      version: VERSION,
      update: updates.newRelease(),
      ytdlp: ytdlpVersion(),
      port: config.port,
      repo: `https://github.com/${config.repo}`,
      lan: lanAddresses().map((ip) => `http://${ip}:${config.port}`),
      cookies: cookiesFileOk() ? 'file' : config.cookiesFromBrowser || null,
      pin: pinOn(),
      disk: diskStatus(),
    });
  }

  async function login(req, res, pathname) {
    if (pathname === '/api/login' && req.method === 'GET') return json(res, 200, loginStatus());
    if (pathname === '/api/login/file' && req.method === 'PUT') {
      let text;
      try {
        text = await readText(req);
      } catch {
        return json(res, 413, fail('cookiesTooLarge', 'That file is too big for a cookies.txt.'));
      }
      const problem = saveCookiesFile(text);
      if (problem) return json(res, 400, fail(problem, 'Not a cookies.txt file.'));
      return json(res, 200, loginStatus());
    }
    if (pathname === '/api/login/file' && req.method === 'DELETE') {
      removeCookiesFile();
      return json(res, 200, loginStatus());
    }
    if (pathname === '/api/login/browser' && req.method === 'PUT') {
      const { browser } = await readBody(req);
      if (!setLoginBrowser(browser ? String(browser) : '')) {
        return json(res, 400, fail('browserUnavailable', 'That browser can\'t be used here.'));
      }
      return json(res, 200, loginStatus());
    }
    if (pathname === '/api/login/test' && req.method === 'POST') {
      const { active } = loginStatus();
      if (!active) return json(res, 400, fail('loginNone', 'No login is set.'));
      const result = await testLogin();
      if (!result.ok) log(`login test failed: ${result.detail}`);
      return json(res, 200, { ...result, active });
    }
    return false;
  }

  async function tools(req, res, pathname) {
    if (pathname === '/api/ytdlp' && req.method === 'GET') return json(res, 200, ytdlpStatus());
    if (pathname === '/api/ytdlp/update' && req.method === 'POST') {
      requestYtdlpUpdate('asked for in Settings');
      return json(res, 202, ytdlpStatus());
    }
    if (pathname === '/api/update' && req.method === 'GET') return json(res, 200, updates.updater.status());
    if (pathname === '/api/update' && req.method === 'POST') {
      try {
        const release = await updates.updater.start();
        log(`update to v${release.version} started`);
        sendJson(res, 202, updates.updater.status());
      } catch (e) {
        sendJson(res, 409, fail(e.code || 'updateFailed', e.message));
      }
      return true;
    }
    return false;
  }

  function history(req, res, pathname) {
    if (pathname === '/api/history' && req.method === 'GET') return json(res, 200, listHistory());
    if (pathname === '/api/history' && req.method === 'DELETE') {
      clearHistory();
      return json(res, 200, { ok: true });
    }
    const m = /^\/api\/history\/([a-f0-9]+)$/.exec(pathname);
    if (m && req.method === 'DELETE') {
      removeHistory(m[1]);
      return json(res, 200, { ok: true });
    }
    return false;
  }

  async function preview(req, res) {
    const body = await readBody(req);
    if (!isValidUrl(body.url)) return sendJson(res, 400, fail('invalidUrl', 'Enter a valid link.'));
    // the page went away or asked for another link: stop working on this one
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    try {
      sendJson(res, 200, await getInfo(body.url, gone.signal));
    } catch (e) {
      if (gone.signal.aborted) return res.destroy();
      sendJson(res, 422, e?.message ? e : fail('noInfo', 'Couldn\'t get video info.'));
    }
  }

  async function downloads(req, res, pathname) {
    if (pathname === '/api/jobs' && req.method === 'POST') {
      const body = await readBody(req);
      if (!isValidUrl(body.url)) return json(res, 400, fail('invalidUrl', 'Enter a valid link.'));
      const opts = parseOptions(body);
      opts.trim = parseTrim(body.trim);
      if (opts.trim === undefined) return json(res, 400, fail('badTrim', 'Invalid trim times.'));
      return json(res, 201, publicJob(createJob(body.url, opts, { title: body.title, device: deviceOf(req) })));
    }
    if (pathname === '/api/batches' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        sendJson(res, 201, publicBatch(createBatch(body, deviceOf(req))));
      } catch (e) {
        sendJson(res, 400, fail(e.code, e.message));
      }
      return true;
    }

    const jm = /^\/api\/jobs\/([a-f0-9]+)(\/(events|file|subs)(\/(\d+))?)?$/.exec(pathname);
    if (jm) {
      const job = getJob(jm[1]);
      const sub = jm[3];
      if (!job) {
        if (sub === 'file' || sub === 'subs') return handled(sendText(res, 404, 'File not found or expired.'));
        return json(res, 404, fail('jobNotFound', 'Job not found.'));
      }
      if (!sub && req.method === 'GET') return json(res, 200, publicJob(job));
      if (!sub && req.method === 'DELETE') {
        deleteJob(job);
        return json(res, 200, { ok: true });
      }
      if (sub === 'events' && req.method === 'GET') return handled(openEvents(req, res, job, publicJob(job), isFinal(job.status)));
      // the video by default, or one of its .srt files
      const ready = job.status === 'done';
      if (sub === 'file' && (req.method === 'GET' || req.method === 'HEAD')) {
        return handled(serveFile(req, res, ready ? { path: job.file, name: job.fileName } : null));
      }
      if (sub === 'subs' && jm[5] != null && req.method === 'GET') {
        return handled(serveFile(req, res, ready ? job.subs?.files?.[Number(jm[5])] : null));
      }
    }

    const bm = /^\/api\/batches\/([a-f0-9]+)(\/(events|zip))?$/.exec(pathname);
    if (bm) {
      const batch = getBatch(bm[1]);
      const sub = bm[3];
      if (!batch) return json(res, 404, fail('playlistNotFound', 'Playlist not found.'));
      if (!sub && req.method === 'GET') return json(res, 200, publicBatch(batch));
      if (!sub && req.method === 'DELETE') {
        removeBatch(batch);
        return json(res, 200, { ok: true });
      }
      if (sub === 'events' && req.method === 'GET') {
        const snap = publicBatch(batch);
        return handled(openEvents(req, res, batch, snap, snap.finished));
      }
      if (sub === 'zip' && req.method === 'GET') {
        const zip = await batchZip(batch);
        if (!zip) return json(res, 404, fail('nothingDone', 'Nothing finished yet.'));
        return handled(sendZip(res, zip.name, zip.zip));
      }
    }
    return false;
  }

  return async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (refuseForeign(req, res)) return;
    try {
      if (pathname === '/api/status' && req.method === 'GET') return status(req, res);
      if (await handlePin(req, res, pathname)) return;
      // Everything else in the API needs the PIN (when one is set). The page itself loads
      // without it, so it can ask for the PIN.
      if (pathname.startsWith('/api/') && !signedIn(req)) return sendJson(res, 401, fail('locked', 'Enter the PIN.'));

      if (pathname === '/api/info' && req.method === 'POST') return await preview(req, res);
      if (await login(req, res, pathname) || await tools(req, res, pathname) || history(req, res, pathname)
        || await downloads(req, res, pathname)) return;

      if (req.method === 'GET') return serveStatic(req, res, pathname);
      res.writeHead(405);
      res.end();
    } catch (e) {
      log('request error:', e.message);
      if (!res.headersSent) sendJson(res, 400, fail('badRequest', 'Bad request.'));
      else res.end();
    }
  };
}
