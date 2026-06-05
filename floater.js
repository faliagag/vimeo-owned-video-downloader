/* floater.js v8.0
 * Se inyecta en la pestaña del usuario.
 * Muestra una barra flotante persistente por cada video en descarga.
 * Sobrevive al cierre del popup.
 */
(function () {
  if (window.__VIMEO_FLOATER_ACTIVE__) return;
  window.__VIMEO_FLOATER_ACTIVE__ = true;

  // Contenedor principal
  const container = document.createElement('div');
  container.id = '__vimeo_floater_container__';
  document.body.appendChild(container);

  // Mapa de tarjetas activas: key = vimeoId
  const cards = {};

  function getOrCreateCard(id, title) {
    if (cards[id]) return cards[id];
    const card = document.createElement('div');
    card.className = '__vdf_card';
    card.innerHTML = `
      <div class="__vdf_header">
        <span class="__vdf_icon">&#9654;</span>
        <span class="__vdf_title">${escHtml(title || 'Video ' + id)}</span>
        <button class="__vdf_close" title="Ocultar">&#x2715;</button>
      </div>
      <div class="__vdf_bar_wrap"><div class="__vdf_bar"></div></div>
      <div class="__vdf_status">Preparando…</div>
    `;
    card.querySelector('.__vdf_close').onclick = () => {
      card.remove();
      delete cards[id];
    };
    container.appendChild(card);
    cards[id] = card;
    return card;
  }

  function escHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function updateCard(id, title, msg, pct) {
    const card = getOrCreateCard(id, title);
    const statusEl = card.querySelector('.__vdf_status');
    const barEl = card.querySelector('.__vdf_bar');
    if (statusEl) statusEl.textContent = msg || '';
    if (barEl && pct >= 0) barEl.style.width = Math.min(pct, 100) + '%';
    if (pct >= 100 || /completad|iniciada|✅/i.test(msg || '')) {
      card.classList.add('__vdf_done');
      setTimeout(() => { if (card.parentNode) { card.classList.add('__vdf_fadeout'); setTimeout(() => { card.remove(); delete cards[id]; }, 800); } }, 5000);
    }
    if (/❌|error/i.test(msg || '')) card.classList.add('__vdf_error');
  }

  // Escuchar mensajes del SW
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'CONVERT_PROGRESS' && msg.__videoId) {
      updateCard(msg.__videoId, msg.__title, msg.message, msg.pct);
    }
    if (msg?.type === 'FLOATER_START') {
      updateCard(msg.videoId, msg.title, 'Iniciando…', 0);
    }
    if (msg?.type === 'FLOATER_DONE') {
      updateCard(msg.videoId, msg.title, msg.message || '✅ Listo', 100);
    }
    if (msg?.type === 'FLOATER_ERROR') {
      updateCard(msg.videoId, msg.title, '❌ ' + (msg.message || 'Error'), -1);
    }
  });

  window.__vimeoFloaterUpdate = updateCard;
})();
