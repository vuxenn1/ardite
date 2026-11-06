// The "Secure connection" page a phone opens (/secure): how to install Ardite's certificate on
// this kind of device, and a check that says "Done" once https:// works here.

const secureUrl = `https://${location.host}/`;
const already = location.protocol === 'https:';

function guessOs() {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  // iPads say they're Macs, but Macs have no touch screen
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  return 'pc';
}
let os = guessOs();

const STEPS = { android: 4, ios: 5, pc: 3 };

function render() {
  applyI18n();
  for (const b of document.querySelectorAll('[data-os]')) b.setAttribute('aria-pressed', String(b.dataset.os === os));
  const list = document.getElementById('steps');
  list.replaceChildren();
  for (let i = 1; i <= STEPS[os]; i++) {
    const li = document.createElement('li');
    li.innerHTML = t(`secure.${os}.${i}`);
    list.append(li);
  }
  const open = document.getElementById('secureOpen');
  open.href = secureUrl;
  renderCheck();
}

let works = already;
function renderCheck() {
  const el = document.getElementById('secureCheck');
  el.textContent = already ? t('secure.already') : works ? t('secure.works') : t('secure.waiting');
  el.classList.toggle('ok', works);
  document.getElementById('secureOpen').hidden = !works || already;
}

// The browser only loads from https://this-pc once it trusts the certificate
async function check() {
  if (works) return;
  try {
    await fetch(`${secureUrl}icon.svg?check=${Date.now()}`, { mode: 'no-cors', cache: 'no-store' });
    works = true;
    renderCheck();
  } catch {
    setTimeout(check, 3000);
  }
}

for (const b of document.querySelectorAll('[data-os]')) {
  b.addEventListener('click', () => {
    os = b.dataset.os;
    render();
  });
}
render();
check();
