/* floater.js v8.2
 * SINGLETON REAL: usa un div con id fijo en el DOM.
 * Si ya existe el contenedor, NO se vuelve a crear ni inyectar.
 * Las tarjetas se identifican por data-vid attribute, no por Map en memoria.
 * Asi sobrevive recargas de extension sin duplicar nada.
 */
(function () {
  // Singleton: si ya existe el contenedor en el DOM, salir
  if (document.getElementById('__vdf_wrap__')) {
    // Solo registrar el listener si no esta registrado
    if (!window.__VIMEO_FLOATER_LISTENER__) setupListener();
    return;
  }

  // Crear contenedor una sola vez
  const wrap = document.createElement('div');
  wrap.id = '__vdf_wrap__';
  wrap.style.cssText = [
    'position:fixed',
    'bottom:20px',
    'right:20px',
    'z-index:2147483647',
    'display:flex',
    'flex-direction:column',
    'gap:10px',
    'max-width:340px',
    'width:340px',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'pointer-events:none'
  ].join(';');
  document.documentElement.appendChild(wrap);

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function getCard(vid) {
    return wrap.querySelector('[data-vid="' + CSS.escape(String(vid)) + '"]');
  }

  function createCard(vid, title) {
    const card = document.createElement('div');
    card.setAttribute('data-vid', String(vid));
    card.style.cssText = [
      'background:rgba(15,18,28,0.97)',
      'border:1px solid rgba(255,255,255,0.1)',
      'border-radius:12px',
      'padding:14px 16px',
      'pointer-events:all',
      'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
      'transition:opacity 0.4s ease'
    ].join(';');
    card.innerHTML = [
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">',
        '<span style="color:#4fc3f7;font-size:14px;flex-shrink:0">&#9654;</span>',
        '<span class="__vdf_t" style="color:#fff;font-size:13px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(title) + '">' + esc(title || 'Video ' + vid) + '</span>',
        '<button style="background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:16px;line-height:1;padding:0 0 0 8px;flex-shrink:0" title="Cerrar">&#x2715;</button>',
      '</div>',
      '<div style="background:rgba(255,255,255,0.08);border-radius:6px;height:5px;overflow:hidden;margin-bottom:8px">',
        '<div class="__vdf_b" style="height:100%;width:0%;background:linear-gradient(90deg,#1976d2,#4fc3f7);border-radius:6px;transition:width 0.4s ease"></div>',
      '</div>',
      '<div class="__vdf_s" style="color:rgba(255,255,255,0.55);font-size:11px">Iniciando&hellip;</div>'
    ].join('');
    card.querySelector('button').onclick = () => card.remove();
    wrap.appendChild(card);
    return card;
  }

  function updateCard(vid, title, msg, pct) {
    if (!vid) return;
    let card = getCard(vid);
    if (!card) card = createCard(vid, title);

    // Actualizar titulo si llega mejor dato
    if (title) card.querySelector('.__vdf_t').textContent = title;

    // Actualizar mensaje
    const sEl = card.querySelector('.__vdf_s');
    if (sEl && msg) sEl.textContent = msg;

    // Actualizar barra
    const bEl = card.querySelector('.__vdf_b');
    if (bEl && pct >= 0) {
      bEl.style.width = Math.min(pct, 100) + '%';
    }

    // Estado: completado
    if (pct >= 100 || /iniciada|\u2705|listo/i.test(msg || '')) {
      bEl && (bEl.style.background = 'linear-gradient(90deg,#2e7d32,#66bb6a)');
      if (sEl) sEl.style.color = '#66bb6a';
      setTimeout(() => {
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 500);
      }, 5000);
    }

    // Estado: error
    if (/\u274c|error/i.test(msg || '')) {
      bEl && (bEl.style.background = '#c62828');
      if (sEl) sEl.style.color = '#ef9a9a';
    }
  }

  function setupListener() {
    if (window.__VIMEO_FLOATER_LISTENER__) return;
    window.__VIMEO_FLOATER_LISTENER__ = true;
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      const vid = msg.videoId || msg.__videoId;
      const title = msg.title || msg.__title;
      if (msg.type === 'CONVERT_PROGRESS' && vid) {
        updateCard(vid, title, msg.message, msg.pct);
      }
      if (msg.type === 'FLOATER_START' && vid) {
        // Eliminar tarjeta vieja si existia (evita fantasmas de sesiones anteriores)
        const old = getCard(vid);
        if (old) old.remove();
        updateCard(vid, title, 'Iniciando…', 0);
      }
      if (msg.type === 'FLOATER_DONE' && vid) {
        updateCard(vid, title, msg.message || '\u2705 Listo', 100);
      }
      if (msg.type === 'FLOATER_ERROR' && vid) {
        updateCard(vid, title, '\u274c ' + (msg.message || 'Error'), -1);
      }
    });
  }

  setupListener();
  window.__vimeoFloaterUpdate = updateCard;
})();
