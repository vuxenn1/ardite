// The PC's addresses on the home network, and telling this PC apart from other devices.
import os from 'node:os';

// Addresses a phone on the same Wi-Fi can use, the likeliest first (VPNs and virtual adapters left out)
export function lanAddresses() {
  const skip = /vEthernet|VirtualBox|VMware|WSL|Docker|Loopback|WARP|Cloudflare|Tailscale|ZeroTier|Hamachi|Bluetooth/i;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      list.push(a.address);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b));
}

export const clientIp = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// Requests made on this PC itself: its browser, the .bat scripts
export function isThisPc(req) {
  const ip = clientIp(req);
  if (ip === '127.0.0.1' || ip === '::1') return true;
  return Object.values(os.networkInterfaces()).flat().some((a) => a && a.address === ip);
}

// A rough device type from the browser, shown next to each history entry
export function deviceOf(req) {
  if (isThisPc(req)) return 'pc';
  const ua = req.headers['user-agent'] || '';
  if (/iPhone/.test(ua)) return 'iphone';
  if (/iPad/.test(ua)) return 'ipad';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Linux|CrOS/.test(ua)) return 'linux';
  return 'other';
}
