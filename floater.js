/* floater.js v8.1
 * FIX: getOrCreateCard nunca crea duplicados (usa Map con vimeoId como clave).
 * FIX: escucha CONVERT_PROGRESS con __videoId para actualizar la tarjeta correcta.
 */
(function () {
  if (window.__VIMEO_FLOATER_ACTIVE__) return;
  window.__VIMEO_FLOATER_ACTIVE__ = true;

  const container = document.createElement('div');
  container.id = '__vimeo_floater_container__';
  document.body.appendChild(container);

  const cards = new Map(); // videoId -> HTMLElement

  function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getOrCreateCard(id, title) {
    if (cards.has(id)) return cards.get(id);
    const card = document.createElement('div');
    card.className = '__vdf_card';
    card.innerHTML = `
      <div class="__vdf_header">
        <span class="__vdf_icon">&#9654;</span>
        <span class="__vdf_title">${escHtml(title || 'Video ' + id)}</span>
        <button class="__vdf_close" title="Cerrar">&#x2715;</button>
      </div>
      <div class="__vdf_bar_wrap"><div class="__vdf_bar"></div></div>
      <div class="__vdf_status">Iniciando…</div>
    `;
    card.querySelector('.__vdf_close').onclick = () => {
      card.remove();
      cards.delete(id);
    };
    container.appendChild(card);
    cards.set(id, card);
    return card;
  }

  function updateCard(id, title, msg, pct) {
    const card = getOrCreateCard(id, title);
    const statusEl = card.querySelector('.__vdf_status');
    const barEl = card.querySelector('.__vdf_bar');
    if (statusEl) statusEl.textContent = msg || '';
    if (barEl && pct >= 0) barEl.style.width = Math.min(pct, 100) + '%';
    if (pct >= 100 || /iniciada|\u2705/i.test(msg || '')) {
      card.classList.add('__vdf_done');
      setTimeout(() => {
        if (card.parentNode) {
          card.classList.add('__vdf_fadeout');
          setTimeout(() => { card.remove(); cards.delete(id); }, 800);
        }
      }, 5000);
    }
    if (/\u274c|error/i.test(msg || '')) card.classList.add('__vdf_error');
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'CONVERT_PROGRESS' && msg.__videoId) {
      updateCard(msg.__videoId, msg.__title, msg.message, msg.pct);
    }
    if (msg.type === 'FLOATER_START') {
      updateCard(msg.videoId, msg.title, 'Iniciando…', 0);
    }
    if (msg.type === 'FLOATER_DONE') {
      updateCard(msg.videoId, msg.title, msg.message || '\u2705 Listo', 100);
    }
    if (msg.type === 'FLOATER_ERROR') {
      updateCard(msg.videoId, msg.title, '\u274c ' + (msg.message || 'Error'), -1);
    }
  });

  window.__vimeoFloaterUpdate = updateCard;
})();
