import { getSettings, setSettings, normalizeDomain } from './shared.js';

const textarea = document.getElementById('domains');
const msg = document.getElementById('msg');

async function load() {
  const settings = await getSettings();
  textarea.value = (settings.allowedDomains || []).join('\n');
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const allowedDomains = textarea.value
    .split(/\r?\n/)
    .map(normalizeDomain)
    .filter(Boolean);
  await setSettings({ allowedDomains });
  msg.textContent = '✅ Opciones guardadas.';
  setTimeout(() => { msg.textContent = ''; }, 3000);
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  textarea.value = '';
  await setSettings({ allowedDomains: [] });
  msg.textContent = 'Lista restablecida.';
});

load();
