// Ardite web UI, last part: starts the page once every other part is loaded.

// ---------- startup ----------

applyI18n();
applyTheme();
setMode(settings.mode === 'audio' ? 'audio' : 'video');
updateInputButtons();
loadHistory();
restoreTasks();
loadStatus();
// lets phones install Ardite as an app (and get it in the Share menu on Android); needs https://
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Links shared from another app or shortcut: /?url=... opens the preview. Nothing downloads until
// the download button is pressed, so a link on some other page can't start a download by itself.
{
  const params = new URLSearchParams(location.search);
  const shared = extractUrl(params.get('url') || params.get('u') || params.get('text') || '');
  if (shared) {
    const mode = params.get('mode');
    if (mode === 'audio' || mode === 'video') setMode(mode);
    history.replaceState(null, '', '/');
    input.value = shared;
    updateInputButtons();
    loadPreview(shared);
  } else if (!isTouch) {
    input.focus();
  }
}
