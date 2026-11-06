// The service worker that lets phones install Ardite as an app. It keeps nothing offline (Ardite
// needs the PC anyway): when the PC can't be reached, the app shows a short note instead of the
// browser's error page.
const TEXT = {
  en: ['Ardite can\'t be reached', 'Is the computer on and is this device on the same Wi-Fi?', 'Try again'],
  tr: ['Ardite\'ye ulaşılamıyor', 'Bilgisayar açık mı, bu cihaz aynı Wi-Fi ağında mı?', 'Tekrar dene'],
};

function offlinePage() {
  const [title, text, button] = TEXT[(self.navigator.language || '').slice(0, 2)] || TEXT.en;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ardite</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;
background:#0b0b0c;color:#eee;text-align:center;padding:24px;box-sizing:border-box}h1{font-size:20px}p{color:#aaa}
button{font:600 15px system-ui;padding:12px 20px;border:0;border-radius:12px;background:#f07a2a;color:#160b03}</style>
<div><h1>${title}</h1><p>${text}</p><button onclick="location.reload()">${button}</button></div>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// only page loads are looked at; everything else goes straight to the PC
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(offlinePage));
});
