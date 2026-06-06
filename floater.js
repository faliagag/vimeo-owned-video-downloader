/* floater.js v8.3
 * SIN estilos inline (CSP safe).
 * Singleton por id DOM. Tarjetas por data-vid.
 * Clases CSS en floater.css.
 */
(function () {
  // Singleton: si ya existe el contenedor, solo asegurar listener
  if (document.getElementById('__vdf_wrap__')) {
    _setupListener();
    return;
  }

  const wrap = document.createElement('div');
  wrap.id = '__vdf_wrap__';
  document.documentElement.appendChild(wrap);

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function getCard(vid) {
    return wrap.querySelector('[data-vid="' + String(vid).replace(/"/g, '&quot;') + '"]');
  }

  function createCard(vid, title) {
    const card = document.createElement('div');
    card.className = 'vdf-card';
    card.setAttribute('data-vid', String(vid));
    card.innerHTML = [
      '<div class="vdf-header">',
        '<span class="vdf-icon">&#9654;</span>',
        '<span class="vdf-title" title="' + esc(title) + '">' + esc(title || 'Video ' + vid) + '</span>',
        '<button class="vdf-close" title="Cerrar">&#x2715;</button>',
      '</div>',
      '<div class="vdf-bar-wrap"><div class="vdf-bar"></div></div>',
      '<div class="vdf-status">Iniciando&hellip;</div>'
    ].join('');
    card.querySelector('.vdf-close').addEventListener('click', function() {
      card.remove();
    });
    wrap.appendChild(card);
    return card;
  }

  function updateCard(vid, title, msg, pct) {
    if (!vid) return;
    let card = getCard(vid);
    if (!card) card = createCard(vid, title);

    if (title) {
      const t = card.querySelector('.vdf-title');
      if (t) t.textContent = title;
    }

    const sEl = card.querySelector('.vdf-status');
    if (sEl && msg) sEl.textContent = msg;

    const bEl = card.querySelector('.vdf-bar');
    if (bEl && pct >= 0) bEl.style.width = Math.min(pct, 100) + '%';

    const done = pct >= 100 || /iniciada|\u2705|listo/i.test(msg || '');
    const err  = /\u274c|error/i.test(msg || '');

    if (done) {
      card.classList.add('vdf-done');
      setTimeout(function() {
        card.classList.add('vdf-fadeout');
        setTimeout(function() { card.remove(); }, 500);
      }, 5000);
    }
    if (err) card.classList.add('vdf-error');
  }

  window.__vimeoFloaterUpdate = updateCard;

  function _setupListener() {
    if (window.__VIMEO_FLOATER_LISTENER__) return;
    window.__VIMEO_FLOATER_LISTENER__ = true;
    try {
      chrome.runtime.onMessage.addListener(function(msg) {
        if (!msg) return;
        var vid   = msg.videoId || msg.__videoId;
        var title = msg.title   || msg.__title;
        if (msg.type === 'CONVERT_PROGRESS' && vid) updateCard(vid, title, msg.message, msg.pct);
        if (msg.type === 'FLOATER_START' && vid) {
          var old = getCard(vid);
          if (old) old.remove();
          updateCard(vid, title, 'Iniciando…', 0);
        }
        if (msg.type === 'FLOATER_DONE'  && vid) updateCard(vid, title, msg.message || '\u2705 Listo', 100);
        if (msg.type === 'FLOATER_ERROR' && vid) updateCard(vid, title, '\u274c ' + (msg.message || 'Error'), -1);
      });
    } catch(e) {}
  }

  _setupListener();
})();
