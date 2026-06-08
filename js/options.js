// options.js — sin ES modules
(function () {
  'use strict';

  function normalizeDomain(value) {
    return (value || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '');
  }

  const textarea = document.getElementById('domains');
  const msg = document.getElementById('msg');

  async function load() {
    const data = await chrome.storage.local.get({ allowedDomains: [] });
    textarea.value = (data.allowedDomains || []).join('\n');
  }

  document.getElementById('saveBtn').addEventListener('click', async () => {
    const allowedDomains = textarea.value
      .split(/\r?\n/)
      .map(normalizeDomain)
      .filter(Boolean);
    await chrome.storage.local.set({ allowedDomains });
    msg.textContent = '\u2705 Opciones guardadas.';
    setTimeout(() => { msg.textContent = ''; }, 3000);
  });

  document.getElementById('resetBtn').addEventListener('click', async () => {
    textarea.value = '';
    await chrome.storage.local.set({ allowedDomains: [] });
    msg.textContent = 'Lista restablecida.';
  });

  load();
})();
