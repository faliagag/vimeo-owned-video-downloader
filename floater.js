/* floater.js v9.0 — indicador flotante de progreso en la página */
'use strict';
(function () {
  if (window.__VIMEO_FLOATER_V90__) return;
  window.__VIMEO_FLOATER_V90__ = true;

  function getOrCreate() {
    let el = document.getElementById('__vimeo_floater__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__vimeo_floater__';
      el.className = 'vdf-floater';
      el.innerHTML = '<div class="vdf-title">🎬 Vimeo Downloader</div><div class="vdf-msg">Iniciando…</div><div class="vdf-bar-wrap"><div class="vdf-bar" style="width:0%"></div></div>';
      document.body.appendChild(el);
    }
    return el;
  }

  function update(msg, pct) {
    const el = getOrCreate();
    el.querySelector('.vdf-msg').textContent = msg || '';
    const bar = el.querySelector('.vdf-bar');
    if (pct >= 0) bar.style.width = Math.min(pct, 100) + '%';
    if (pct >= 100) setTimeout(() => { try { el.remove(); delete window.__VIMEO_FLOATER_V90__; } catch(_){} }, 3000);
    if (pct < 0) { bar.style.background = '#ef4444'; }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'FLOATER_START') { getOrCreate(); }
    if (msg?.type === 'CONVERT_PROGRESS') { update(msg.message, msg.pct); }
  });
})();
