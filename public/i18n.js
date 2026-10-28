// Ardite UI translations.
// To add a language, copy the "en" block, translate the values and add a button for it in index.html.
// Values can be functions when they need numbers or other values inserted.

const enPlural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const STRINGS = {
  en: {
    'home': 'Ardite home',
    'hero.line1': 'Paste a link.',
    'hero.line2': 'Get the video.',
    'hero.sub': 'YouTube, Instagram, TikTok, X, Reddit, Twitch and 1,000+ other sites. Playlists too.',
    'input.placeholder': 'Paste a video or playlist link',
    'input.label': 'Video link',
    'clear': 'Clear',
    'paste': 'Paste',
    'download': 'Download',
    'close': 'Close',
    'settings': 'Settings',
    'mode.label': 'Download type',
    'mode.video': 'Video',
    'mode.audio': 'Audio only',
    'opts.label': 'Options',
    'history.title': 'Recent downloads',
    'foot': 'Running on your home PC',
    'foot.version': (v) => `Running on your home PC · yt-dlp ${v}`,

    'phone.btn': 'Open on your phone',
    'phone.title': 'Use it on your phone',
    'phone.card': 'Connect your phone to the <b>same Wi-Fi</b> and scan this code.',
    'phone.tip': 'Tip: on your phone, tap "Add to Home Screen" and it opens like an app.',
    'phone.dlg': 'Connect your phone to the <b>same Wi-Fi</b>, then scan the code or type the address.',
    'phone.note': 'Files are saved to whichever device you open Ardite on.',

    'set.format': 'Video format',
    'set.h264': 'Compatible (MP4 · H.264)',
    'set.h264.desc': 'Plays on every device and app, iPhone included. Usually up to 1080p on YouTube.',
    'set.best': 'Highest quality (VP9 / AV1)',
    'set.best.desc': 'For 4K and 8K. May not play on some older phones or in video editors.',
    'set.general': 'General',
    'set.autoSave': 'Save automatically',
    'set.autoSave.desc': 'Save the file as soon as it\'s ready. Playlists always wait for you.',
    'set.theme': 'Theme',
    'set.lang': 'Language',
    'auto': 'Auto',
    'theme.light': 'Light',
    'theme.dark': 'Dark',

    'q.auto': 'Auto',
    'q.best': 'Best',
    'fmt.original': 'Original',
    'hint.auto': 'Auto picks the best MP4 that plays everywhere (usually 1080p on YouTube). For 4K, pick 4K or switch to "Highest quality" in {settings}.',

    'toast.noClipLink': 'No link on the clipboard.',
    'toast.clipFail': 'Couldn\'t read the clipboard. Paste the link manually.',
    'toast.notLink': 'That doesn\'t look like a link.',
    'toast.pasteFirst': 'Paste a link first.',
    'toast.loadingPlaylist': 'Loading the playlist…',
    'toast.selectOne': 'Select at least one video.',
    'toast.playlistReady': 'Playlist ready.',
    'toast.playlistReadyFailed': (n) => `Playlist ready, ${n} failed.`,
    'toast.saving': (n) => `Saving ${enPlural(n, 'file')}… your browser may ask to allow multiple downloads.`,

    'untitled': 'Untitled',
    'upTo': (q) => `up to ${q}`,
    'audioOnly': 'audio only',
    'playlistBadge': (n) => `Playlist · ${enPlural(n, 'video')}`,
    'scope.video': 'This video',
    'scope.playlist': (n) => `Whole playlist (${n})`,
    'selectAll': 'Select all',
    'selected': (n, total) => `${n} of ${total} selected`,
    'unavailable': 'Unavailable',
    'truncated': (n) => `Only the first ${n} videos are shown.`,
    'batch.select': 'Select videos to download',
    'batch.audio': (n, format) => `Download ${n} as ${format}`,
    'batch.audioAny': 'audio',
    'batch.video': (n) => `Download ${enPlural(n, 'video')}`,

    'st.queued': 'Waiting in queue…',
    'st.queuedShort': 'Queued',
    'st.ready': 'Ready',
    'st.failed': 'Failed',
    'st.canceled': 'Canceled',
    'st.allFailed': 'All downloads failed',
    'eta.s': (s) => `${s}s left`,
    'eta.m': (m, s) => `${m}m ${s}s left`,
    'files': (n) => enPlural(n, 'file'),
    'nFailed': (n) => `${n} failed`,
    'b.progress': (done, total) => `${done} of ${total} done`,
    'b.active': (n) => `downloading ${n}`,
    'item': 'Video',
    'items.show': (n) => `Show ${enPlural(n, 'item')}`,
    'items.hide': 'Hide items',

    'save': 'Save',
    'saveAll': 'Save all',
    'zip': 'Download ZIP',
    'retry': 'Retry',
    'remove': 'Remove',
    'cancel': 'Cancel',
    'again': 'Again',

    'phase.queued': 'Queued',
    'phase.starting': 'Starting',
    'phase.downloading': 'Downloading',
    'phase.downloading-audio': 'Downloading audio',
    'phase.downloading-video': 'Downloading video',
    'phase.merging': 'Merging video and audio',
    'phase.converting': 'Converting audio',
    'phase.cover': 'Adding cover art',
    'phase.finishing': 'Finishing up',
    'phase.retrying': 'Retrying',
    'phase.ready': 'Ready',
    'phase.canceled': 'Canceled',

    'err.generic': 'Something went wrong.',
    'err.unsupported': 'This site or link isn\'t supported.',
    'err.signin': 'YouTube wants you to sign in. Adding cookies should fix it (see README.md).',
    'err.private': 'This video is private.',
    'err.login': 'This content requires login. Adding cookies should fix it (see README.md).',
    'err.format': 'That quality isn\'t available for this video. Try another one.',
    'err.notFound': 'Video not found or removed.',
    'err.network': 'Couldn\'t reach the site. Check your internet connection.',
    'err.noVideo': 'No downloadable video found at this link.',
    'err.failed': 'Download failed.',
    'err.noFile': 'No file was produced.',
    'err.invalidUrl': 'Enter a valid link.',
    'err.noInfo': 'Couldn\'t get video info.',
    'err.noSelection': 'No videos selected.',
    'err.nothingDone': 'Nothing finished yet.',
    'err.jobNotFound': 'Download not found.',
    'err.playlistNotFound': 'Playlist not found.',
    'err.badRequest': 'Bad request.',
  },

  tr: {
    'home': 'Ardite ana sayfa',
    'hero.line1': 'Linki yapıştır.',
    'hero.line2': 'Videoyu al.',
    'hero.sub': 'YouTube, Instagram, TikTok, X, Reddit, Twitch ve 1.000\'den fazla site. Oynatma listeleri de.',
    'input.placeholder': 'Video veya oynatma listesi linki yapıştır',
    'input.label': 'Video linki',
    'clear': 'Temizle',
    'paste': 'Yapıştır',
    'download': 'İndir',
    'close': 'Kapat',
    'settings': 'Ayarlar',
    'mode.label': 'İndirme türü',
    'mode.video': 'Video',
    'mode.audio': 'Sadece ses',
    'opts.label': 'Seçenekler',
    'history.title': 'Son indirilenler',
    'foot': 'Evdeki bilgisayarında çalışıyor',
    'foot.version': (v) => `Evdeki bilgisayarında çalışıyor · yt-dlp ${v}`,

    'phone.btn': 'Telefonda aç',
    'phone.title': 'Telefonunda kullan',
    'phone.card': 'Telefonunu <b>aynı Wi-Fi</b> ağına bağla ve bu kodu okut.',
    'phone.tip': 'İpucu: telefonda "Ana Ekrana Ekle"ye dokunursan uygulama gibi açılır.',
    'phone.dlg': 'Telefonunu <b>aynı Wi-Fi</b> ağına bağla, sonra kodu okut ya da adresi yaz.',
    'phone.note': 'Dosyalar, Ardite\'yi hangi cihazda açtıysan oraya kaydedilir.',

    'set.format': 'Video biçimi',
    'set.h264': 'Uyumlu (MP4 · H.264)',
    'set.h264.desc': 'iPhone dahil her cihazda ve uygulamada oynar. YouTube\'da genelde en fazla 1080p.',
    'set.best': 'En yüksek kalite (VP9 / AV1)',
    'set.best.desc': '4K ve 8K için. Bazı eski telefonlarda ve video düzenleyicilerde oynamayabilir.',
    'set.general': 'Genel',
    'set.autoSave': 'Otomatik kaydet',
    'set.autoSave.desc': 'Dosya hazır olur olmaz kaydedilir. Oynatma listeleri her zaman seni bekler.',
    'set.theme': 'Tema',
    'set.lang': 'Dil',
    'auto': 'Otomatik',
    'theme.light': 'Açık',
    'theme.dark': 'Koyu',

    'q.auto': 'Otomatik',
    'q.best': 'En iyi',
    'fmt.original': 'Orijinal',
    'hint.auto': 'Otomatik, her yerde oynayan en iyi MP4\'ü seçer (YouTube\'da genelde 1080p). 4K için 4K\'yı seç ya da {settings} bölümünden "En yüksek kalite"ye geç.',

    'toast.noClipLink': 'Panoda link yok.',
    'toast.clipFail': 'Pano okunamadı. Linki elle yapıştır.',
    'toast.notLink': 'Bu bir linke benzemiyor.',
    'toast.pasteFirst': 'Önce bir link yapıştır.',
    'toast.loadingPlaylist': 'Oynatma listesi yükleniyor…',
    'toast.selectOne': 'En az bir video seç.',
    'toast.playlistReady': 'Oynatma listesi hazır.',
    'toast.playlistReadyFailed': (n) => `Oynatma listesi hazır, ${n} tanesi indirilemedi.`,
    'toast.saving': (n) => `${n} dosya kaydediliyor… tarayıcın birden fazla indirme için izin isteyebilir.`,

    'untitled': 'Başlıksız',
    'upTo': (q) => `en fazla ${q}`,
    'audioOnly': 'sadece ses',
    'playlistBadge': (n) => `Oynatma listesi · ${n} video`,
    'scope.video': 'Bu video',
    'scope.playlist': (n) => `Tüm liste (${n})`,
    'selectAll': 'Tümünü seç',
    'selected': (n, total) => `${total} videodan ${n} seçili`,
    'unavailable': 'Erişilemiyor',
    'truncated': (n) => `Sadece ilk ${n} video gösteriliyor.`,
    'batch.select': 'İndirilecek videoları seç',
    'batch.audio': (n, format) => `${n} videoyu ${format} olarak indir`,
    'batch.audioAny': 'ses',
    'batch.video': (n) => `${n} video indir`,

    'st.queued': 'Sırada bekliyor…',
    'st.queuedShort': 'Sırada',
    'st.ready': 'Hazır',
    'st.failed': 'Başarısız',
    'st.canceled': 'İptal edildi',
    'st.allFailed': 'Hiçbiri indirilemedi',
    'eta.s': (s) => `${s} sn kaldı`,
    'eta.m': (m, s) => `${m} dk ${s} sn kaldı`,
    'files': (n) => `${n} dosya`,
    'nFailed': (n) => `${n} başarısız`,
    'b.progress': (done, total) => `${done}/${total} tamamlandı`,
    'b.active': (n) => `${n} tanesi iniyor`,
    'item': 'Video',
    'items.show': (n) => `${n} öğeyi göster`,
    'items.hide': 'Öğeleri gizle',

    'save': 'Kaydet',
    'saveAll': 'Tümünü kaydet',
    'zip': 'ZIP indir',
    'retry': 'Tekrar dene',
    'remove': 'Kaldır',
    'cancel': 'İptal',
    'again': 'Tekrar',

    'phase.queued': 'Sırada',
    'phase.starting': 'Başlıyor',
    'phase.downloading': 'İndiriliyor',
    'phase.downloading-audio': 'Ses indiriliyor',
    'phase.downloading-video': 'Görüntü indiriliyor',
    'phase.merging': 'Görüntü ve ses birleştiriliyor',
    'phase.converting': 'Ses dönüştürülüyor',
    'phase.cover': 'Kapak ekleniyor',
    'phase.finishing': 'Bitiriliyor',
    'phase.retrying': 'Tekrar deneniyor',
    'phase.ready': 'Hazır',
    'phase.canceled': 'İptal edildi',

    'err.generic': 'Bir şeyler ters gitti.',
    'err.unsupported': 'Bu site veya link desteklenmiyor.',
    'err.signin': 'YouTube giriş yapmanı istiyor. Çerez (cookies) eklemek sorunu çözer (README.md\'ye bak).',
    'err.private': 'Bu video gizli.',
    'err.login': 'Bu içerik giriş gerektiriyor. Çerez (cookies) eklemek sorunu çözer (README.md\'ye bak).',
    'err.format': 'Bu video için o kalite yok. Başka birini dene.',
    'err.notFound': 'Video bulunamadı veya kaldırılmış.',
    'err.network': 'Siteye ulaşılamadı. İnternet bağlantını kontrol et.',
    'err.noVideo': 'Bu linkte indirilebilir video bulunamadı.',
    'err.failed': 'İndirme başarısız.',
    'err.noFile': 'Dosya oluşturulamadı.',
    'err.invalidUrl': 'Geçerli bir link gir.',
    'err.noInfo': 'Video bilgisi alınamadı.',
    'err.noSelection': 'Hiç video seçilmedi.',
    'err.nothingDone': 'Henüz biten bir şey yok.',
    'err.jobNotFound': 'İndirme bulunamadı.',
    'err.playlistNotFound': 'Oynatma listesi bulunamadı.',
    'err.badRequest': 'Geçersiz istek.',
  },
};

let lang = 'en';

// "auto" follows the browser's language list, falling back to English
function setLang(pref) {
  lang = 'en';
  if (pref && pref !== 'auto' && STRINGS[pref]) lang = pref;
  else {
    for (const l of navigator.languages || [navigator.language]) {
      const code = String(l || '').slice(0, 2).toLowerCase();
      if (STRINGS[code]) { lang = code; break; }
    }
  }
  document.documentElement.lang = lang;
}

const hasText = (key) => key in STRINGS[lang] || key in STRINGS.en;

function t(key, ...args) {
  const v = STRINGS[lang][key] ?? STRINGS.en[key];
  if (v == null) return key;
  return typeof v === 'function' ? v(...args) : v;
}

// Fills elements marked in the HTML:
//   data-i18n="key"                     -> text
//   data-i18n-html="key"                -> HTML (only our own strings)
//   data-i18n-attr="title:key,aria-label:key" -> attributes
function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':');
      el.setAttribute(attr.trim(), t(key.trim()));
    }
  }
}

try {
  setLang(JSON.parse(localStorage.getItem('ardite.settings') || '{}').lang);
} catch {
  setLang('auto');
}
