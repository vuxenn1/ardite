// HTTPS: Ardite's own certificates (cert.js) and the server answering http:// and https:// on
// one port (tls.js), checked with real TLS connections that trust only Ardite's authority.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { makeAuthority, makeServerCert, coveredBy, wanted, isHomeAddress } from '../lib/cert.js';
import { certNames } from '../lib/tls.js';
import { startServer } from '../.github/test-server.mjs';

// GET over https:// trusting only `ca`; { status, body } or { error }
function getHttps({ port, host = '127.0.0.1', path = '/', ca, localAddress, servername }) {
  return new Promise((resolve) => {
    https.get({ host, port, path, ca, localAddress, servername, agent: false, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', (e) => resolve({ error: e.code || e.message }));
  });
}
function getHttp({ port, path = '/', localAddress }) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, localAddress, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// A plain https server with the given certificate, for the certificate tests
async function serve(cert) {
  const server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => res.end('hello')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return server;
}

test('the certificate authority signs a PC certificate that phones accept', async (t) => {
  const ca = makeAuthority('Test PC');
  const x = new crypto.X509Certificate(ca.cert);
  assert.ok(x.ca);
  assert.match(x.subject, /CN=Ardite on Test PC/);
  assert.ok(x.verify(x.publicKey), 'signed by itself');

  const names = { names: ['localhost', 'test-pc.local'], ips: ['127.0.0.1', '192.168.1.20'] };
  const leaf = makeServerCert(ca, names);
  const lx = new crypto.X509Certificate(leaf.cert);
  assert.ok(!lx.ca);
  assert.ok(lx.checkIssued(x) && lx.verify(x.publicKey), 'signed by the authority');
  assert.deepEqual(coveredBy(leaf.cert), wanted(names));
  const days = (new Date(lx.validTo) - Date.now()) / 86400000;
  assert.ok(days > 390 && days <= 397, `valid for ${days} days`);

  const server = await serve(leaf);
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal((await getHttps({ port, ca: ca.cert })).body.toString(), 'hello', 'by IP address');
  assert.equal((await getHttps({ port, ca: ca.cert, host: 'localhost' })).status, 200, 'by name');
  assert.equal((await getHttps({ port, ca: ca.cert, servername: 'test-pc.local' })).status, 200, 'by the PC name');
  // a name it doesn't cover is refused
  assert.equal((await getHttps({ port, ca: ca.cert, servername: 'other-pc.local' })).error, 'ERR_TLS_CERT_ALTNAME_INVALID');
  // without the authority installed, the browser refuses it
  assert.ok((await getHttps({ port })).error);
  // another authority's certificate isn't trusted either
  const other = makeAuthority('Other');
  assert.ok((await getHttps({ port, ca: other.cert })).error);
});

test('the authority can never vouch for a real website or a public address', async (t) => {
  const ca = makeAuthority('Test PC');
  for (const names of [{ names: ['example.com'], ips: [] }, { names: [], ips: ['8.8.8.8'] }]) {
    const server = await serve(makeServerCert(ca, names));
    t.after(() => server.close());
    const res = await getHttps({ port: server.address().port, ca: ca.cert, servername: names.names[0] });
    assert.ok(res.error, `${JSON.stringify(names)} must be refused`);
    assert.doesNotMatch(String(res.error), /ALTNAME/, 'refused for the name constraint, not the address');
  }
});

test('the PC certificate covers localhost, the PC name and only home addresses', () => {
  assert.deepEqual(certNames(['192.168.1.20', '10.0.0.5', '8.8.8.8', '172.40.0.1'], 'My_PC'), {
    names: ['localhost', 'mypc.local'],
    ips: ['127.0.0.1', '192.168.1.20', '10.0.0.5'],
  });
  assert.ok(isHomeAddress('172.16.0.1') && isHomeAddress('172.31.255.255') && !isHomeAddress('172.32.0.1'));
  assert.ok(isHomeAddress('100.100.1.1'), 'Tailscale addresses count as home');
  assert.ok(!isHomeAddress('::1') && !isHomeAddress('nonsense'));
});

// ---------- the server ----------

let s;
let ca; // the authority's certificate, as a phone downloads it
before(async () => {
  s = await startServer();
});
after(() => s?.stop());

test('one port answers http:// and https://, and phones can download the certificate', async () => {
  const status = await getHttp({ port: s.port, path: '/api/status' });
  assert.equal(JSON.parse(status.body).https, true);

  const crt = await getHttp({ port: s.port, path: '/ardite.crt' });
  assert.equal(crt.status, 200);
  assert.equal(crt.headers['content-type'], 'application/x-x509-ca-cert');
  const x = new crypto.X509Certificate(crt.body);
  assert.ok(x.ca);
  ca = x.toString();

  const secure = await getHttps({ port: s.port, path: '/api/status', ca });
  assert.equal(secure.status, 200);
  assert.equal(JSON.parse(secure.body).name, 'Ardite');
  // and plain http still works after a secure connection
  assert.equal((await getHttp({ port: s.port, path: '/api/status' })).status, 200);

  const page = await getHttp({ port: s.port, path: '/secure' });
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /secure\.js/);
});

test('with a PIN, a locked phone still gets the setup page and the certificate, and nothing else', async () => {
  assert.equal((await s.call('/api/pin', 'PUT', { pin: '2468' })).status, 200);
  try {
    const from = { port: s.port, localAddress: '127.0.0.2' };
    assert.equal((await getHttp({ ...from, path: '/ardite.crt' })).status, 200);
    assert.equal((await getHttp({ ...from, path: '/secure' })).status, 200);
    assert.equal((await getHttp({ ...from, path: '/api/history' })).status, 401);
    assert.equal((await getHttps({ ...from, ca, path: '/api/history' })).status, 401, 'https:// is locked the same way');
  } finally {
    await s.call('/api/pin', 'DELETE');
  }
});
