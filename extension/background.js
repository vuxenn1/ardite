// Ardite for the browser: the toolbar button sends the page you're on to Ardite, and links get a
// "Download with Ardite" menu item. Ardite opens with the link in its preview; nothing downloads
// until you press its download button. Only the page or link you send is read, nothing else.
const api = globalThis.browser || globalThis.chrome;

// The Ardite address: the one set in the options, otherwise the one this copy was downloaded from
async function address() {
  const { address: saved } = await api.storage.sync.get('address');
  if (saved) return saved;
  try {
    return (await (await fetch(api.runtime.getURL('defaults.json'))).json()).address;
  } catch {
    return 'http://localhost:7878';
  }
}

// Ardite with a link to open, or just Ardite for pages that aren't on the web (new tab, settings)
function arditeUrl(base, link) {
  const root = String(base).replace(/\/+$/, '');
  return /^https?:\/\//i.test(link || '') ? `${root}/?url=${encodeURIComponent(link)}` : `${root}/`;
}

async function send(link, tab) {
  await api.tabs.create({ url: arditeUrl(await address(), link), index: tab ? tab.index + 1 : undefined });
}

api.action.onClicked.addListener((tab) => send(tab.url, tab));

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.create({ id: 'ardite', title: api.i18n.getMessage('menu'), contexts: ['link', 'page', 'video', 'audio'] });
});
// a link, otherwise the page itself (a video element's own address is usually only a stream part)
api.contextMenus.onClicked.addListener((info, tab) => send(info.linkUrl || info.pageUrl, tab));
