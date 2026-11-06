// Ardite's own certificates for HTTPS, made with Node's crypto alone (no OpenSSL needed).
// A small certificate authority ("Ardite on <PC>") is made once and installed on the phones; it
// signs the PC's certificate, which is made again whenever the PC's addresses change.
// The authority can only vouch for home addresses (private IPs, localhost, *.local), never for
// real websites, so even if its key leaked it couldn't be used to fake one.
import crypto from 'node:crypto';
import net from 'node:net';

// ---------- DER, the binary form of certificates ----------

function len(n) {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  for (; n > 0; n >>= 8) bytes.unshift(n & 255);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const bool = (v) => tlv(0x01, [v ? 0xff : 0]);
const octets = (b) => tlv(0x04, b);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, ...p) => tlv(0xa0 + n, ...p);
// an unsigned whole number (a leading 0 keeps it from reading as negative)
function int(bytes) {
  let b = Buffer.from(bytes);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}
// bits, given as the number of trailing bits that are unused
const bits = (b, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
function oid(text) {
  const [a, b, ...rest] = text.split('.').map(Number);
  const out = [40 * a + b];
  for (let v of rest) {
    const part = [v & 127];
    for (v = Math.floor(v / 128); v > 0; v = Math.floor(v / 128)) part.unshift(0x80 | (v & 127));
    out.push(...part);
  }
  return tlv(0x06, out);
}
function time(d) {
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(String(y).slice(2) + rest)) : tlv(0x18, Buffer.from(y + rest));
}

// The parts inside a DER sequence, each with its tag and length
function children(der) {
  const out = [];
  let i = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  while (i < der.length) {
    const start = i;
    let n = der[i + 1];
    let head = 2;
    if (n & 0x80) {
      head += n & 0x7f;
      n = 0;
      for (let k = 0; k < (der[i + 1] & 0x7f); k++) n = n * 256 + der[i + 2 + k];
    }
    i += head + n;
    out.push(der.subarray(start, i));
  }
  return out;
}
// A certificate's subject exactly as written in it (tbs: version, serial, algorithm, issuer, validity, subject)
const subjectOf = (x509) => children(children(x509.raw)[0])[5];

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const name = (cn) => seq(set(seq(oid('2.5.4.10'), utf8('Ardite'))), set(seq(oid('2.5.4.3'), utf8(cn))));
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const keyId = (spki) => crypto.createHash('sha1').update(spki).digest();

// What the authority may vouch for: home network addresses only
const PRIVATE_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16]];
const v4 = (ip) => Buffer.from(ip.split('.').map(Number));
const mask = (prefix) => Buffer.from([0, 1, 2, 3].map((i) => (0xff << (8 - Math.min(8, Math.max(0, prefix - i * 8)))) & 0xff));
const PERMITTED_NAMES = ['localhost', 'local'];

export function isHomeAddress(ip) {
  if (!net.isIPv4(ip)) return false;
  const n = (a) => a.split('.').reduce((x, o) => x * 256 + Number(o), 0);
  return PRIVATE_V4.some(([base, prefix]) => Math.floor(n(ip) / 2 ** (32 - prefix)) === Math.floor(n(base) / 2 ** (32 - prefix)));
}

function nameConstraints() {
  const subtree = (general) => seq(general);
  return seq(tlv(0xa0, // permitted
    ...PERMITTED_NAMES.map((n) => subtree(tlv(0x82, Buffer.from(n)))),
    ...PRIVATE_V4.map(([base, prefix]) => subtree(tlv(0x87, Buffer.concat([v4(base), mask(prefix)]))))));
}

function sign({ serialKey, issuer, subject, days, spki, signKey, extensions, from = new Date() }) {
  const notBefore = new Date(from.getTime() - 60 * 60 * 1000); // an hour back, for clocks a bit behind
  const notAfter = new Date(from.getTime() + days * 86400000);
  const serial = crypto.createHash('sha256').update(serialKey).update(crypto.randomBytes(16)).digest().subarray(0, 16);
  serial[0] &= 0x7f;
  const tbs = seq(explicit(0, int([2])), int(serial), ECDSA_SHA256, issuer, seq(time(notBefore), time(notAfter)),
    subject, spki, explicit(3, seq(...extensions)));
  const signature = crypto.sign('sha256', tbs, signKey);
  return seq(tbs, ECDSA_SHA256, bits(signature));
}

const pem = (der, label) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

// The authority, for 10 years. { key, cert } as PEM.
export function makeAuthority(pcName, from) {
  const { privateKey, publicKey } = newKey();
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const subject = name(`Ardite on ${pcName}`.slice(0, 64));
  const cert = sign({
    serialKey: 'ca', issuer: subject, subject, days: 3650, spki, signKey: privateKey, from,
    extensions: [
      extension('2.5.29.19', true, seq(bool(true), int([0]))), // an authority, signing only end certificates
      extension('2.5.29.15', true, bits(Buffer.from([0x86]), 1)), // digital signature, sign certificates and revocations
      extension('2.5.29.14', false, octets(keyId(spki))),
      extension('2.5.29.30', true, nameConstraints()),
    ],
  });
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem(cert, 'CERTIFICATE') };
}

// The PC's certificate for the given names and IPv4 addresses, signed by the authority.
// 397 days, the most phones accept; Ardite makes a new one well before that.
export function makeServerCert(authority, { names = [], ips = [] }, from) {
  const ca = new crypto.X509Certificate(authority.cert);
  const caKey = crypto.createPrivateKey(authority.key);
  const caSpki = ca.publicKey.export({ type: 'spki', format: 'der' });
  const { privateKey, publicKey } = newKey();
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const alt = [...names.map((n) => tlv(0x82, Buffer.from(n))), ...ips.map((ip) => tlv(0x87, v4(ip)))];
  const cert = sign({
    serialKey: 'server', issuer: subjectOf(ca),
    subject: name('Ardite'), days: 397, spki, signKey: caKey, from,
    extensions: [
      extension('2.5.29.19', true, seq()),
      extension('2.5.29.15', true, bits(Buffer.from([0x80]), 7)), // digital signature
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // for websites
      extension('2.5.29.17', false, seq(...alt)),
      extension('2.5.29.14', false, octets(keyId(spki))),
      extension('2.5.29.35', false, seq(tlv(0x80, keyId(caSpki)))),
    ],
  });
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem(cert, 'CERTIFICATE') };
}

// The names and addresses a certificate covers, as "DNS:x" and "IP Address:y" in a sorted list
export const coveredBy = (certPem) => (new crypto.X509Certificate(certPem).subjectAltName || '')
  .split(', ').filter(Boolean).sort();
export const wanted = ({ names, ips }) => [...names.map((n) => `DNS:${n}`), ...ips.map((ip) => `IP Address:${ip}`)].sort();
