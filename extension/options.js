// The extension's one setting: Ardite's address (filled in when it was downloaded from Ardite)
const api = globalThis.browser || globalThis.chrome;
for (const el of document.querySelectorAll('[data-msg]')) el.textContent = api.i18n.getMessage(el.dataset.msg);

const input = document.getElementById('address');
(async () => {
  const { address } = await api.storage.sync.get('address');
  input.value = address || (await (await fetch('defaults.json')).json()).address;
})();

document.getElementById('save').addEventListener('click', async () => {
  let value = input.value.trim().replace(/\/+$/, '');
  if (value && !/^https?:\/\//i.test(value)) value = `http://${value}`;
  input.value = value;
  await api.storage.sync.set({ address: value });
  document.getElementById('saved').hidden = false;
});
