// HTTPS on the same port as HTTP: the first byte a browser sends tells them apart (a TLS
// handshake starts with 22), so http:// and https:// addresses both work and nothing else
// (port, firewall rule) changes. The certificates live in data/tls, see cert.js.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { DATA } from './config.js';
import { log } from './log.js';
import { lanAddresses } from './network.js';
import { makeAuthority, makeServerCert, coveredBy, wanted, isHomeAddress } from './cert.js';

export const TLS_DIR = path.join(DATA, 'tls');
const file = (n) => path.join(TLS_DIR, n);
const read = (n) => (fs.existsSync(file(n)) ? fs.readFileSync(file(n), 'utf8') : null);
function write(n, text, secret) {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  fs.writeFileSync(file(n) + '.tmp', text, secret ? { mode: 0o600 } : {});
  fs.renameSync(file(n) + '.tmp', file(n));
}

// What the PC's certificate should cover: localhost, <pc name>.local and its home network addresses
export function certNames(addresses = lanAddresses(), host = os.hostname()) {
  const pc = String(host).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return {
    names: ['localhost', ...(pc ? [`${pc}.local`] : [])],
    ips: [...new Set(['127.0.0.1', ...addresses.filter(isHomeAddress)])],
  };
}

const DAY = 86400000;
function authority() {
  let key = read('ca.key');
  let cert = read('ca.crt');
  try {
    if (key && cert && new Date(new crypto.X509Certificate(cert).validTo) - Date.now() > 30 * DAY) return { key, cert };
  } catch { /* unreadable: made again */ }
  ({ key, cert } = makeAuthority(os.hostname()));
  write('ca.key', key, true);
  write('ca.crt', cert);
  log('made the certificate authority for HTTPS (phones that installed an older one need the new one)');
  return { key, cert };
}

// The PC's certificate, made again when the addresses changed or it runs out within 30 days
export function serverCert(names = certNames()) {
  const ca = authority();
  let key = read('server.key');
  let cert = read('server.crt');
  try {
    const x = cert && new crypto.X509Certificate(cert);
    if (key && x && x.checkIssued(new crypto.X509Certificate(ca.cert)) && new Date(x.validTo) - Date.now() > 30 * DAY
      && coveredBy(cert).join() === wanted(names).join()) return { key, cert, changed: false };
  } catch { /* made again */ }
  ({ key, cert } = makeServerCert(ca, names));
  write('server.key', key, true);
  write('server.crt', cert);
  log(`made the HTTPS certificate for ${[...names.names, ...names.ips].join(', ')}`);
  return { key, cert, changed: true };
}

// The authority's certificate as phones install it (DER), or null before HTTPS ever ran
export function authorityDer() {
  const cert = read('ca.crt');
  return cert ? Buffer.from(new crypto.X509Certificate(cert).raw) : null;
}

// A server that answers both http:// and https:// on one port with the same handler.
// Falls back to HTTP alone if the certificates can't be made.
export function createServer(handler) {
  const plain = http.createServer(handler);
  let secure = null;
  try {
    const { key, cert } = serverCert();
    secure = https.createServer({ key, cert }, handler);
  } catch (e) {
    log(`HTTPS is off: ${e.message}`);
    return plain;
  }
  const server = net.createServer((socket) => {
    socket.on('error', () => {}); // a phone that drops the connection before the first byte
    socket.setTimeout(30000, () => socket.destroy());
    socket.once('data', (first) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(first);
      (first[0] === 22 ? secure : plain).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  // a new address (another Wi-Fi, a new IP from the router) gets a new certificate
  const refresh = () => {
    try {
      const { key, cert, changed } = serverCert();
      if (changed) secure.setSecureContext({ key, cert });
    } catch (e) {
      log(`couldn't renew the HTTPS certificate: ${e.message}`);
    }
  };
  setInterval(refresh, 5 * 60000).unref();
  return server;
}
