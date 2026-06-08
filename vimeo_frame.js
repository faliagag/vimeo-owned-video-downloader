/* vimeo_frame.js v9.3
 * Se inyecta via scripting en ALL frames de la pagina activa (incluidos iframes de Vimeo)
 * Intenta leer el playerConfig desde variables globales del frame y enviarlo al background
 */
(function () {
  'use strict';
  if (window.location.hostname !== 'player.vimeo.com') return;
  if (window.__vimeoFrameReaderV93) return;
  window.__vimeoFrameReaderV93 = true;

  function extractVideoId() {
    try { const m = location.pathname.match(/\/video\/(\d+)/); return m ? m[1] : null; } catch (_) { return null; }
  }

  function tryGetConfig() {
    const candidates = ['playerConfig', '__playerConfig', 'config'];
    for (const k of candidates) {
      try { const v = window[k]; if (v && v.request && v.request.files) return v; } catch (_) {}
    }
    try {
      for (const k of Object.keys(window)) {
        const v = window[k];
        if (v && typeof v === 'object' && v.request && v.request.files && v.video) return v;
      }
    } catch (_) {}
    return null;
  }

  const cfg = tryGetConfig();
  if (cfg) {
    const videoId = extractVideoId() || String(cfg.video?.id || '');
    window.__VIMEO_CAPTURED_CONFIG__ = window.__VIMEO_CAPTURED_CONFIG__ || {};
    window.__VIMEO_CAPTURED_CONFIG__[videoId] = cfg;
    try {
      window.top.postMessage({ __vimeoExt: true, type: 'VIMEO_CONFIG_CAPTURED', videoId, config: cfg }, '*');
    } catch (_) {}
    try {
      chrome.runtime.sendMessage({ type: '__VIMEO_CONFIG_FROM_FRAME__', videoId, config: cfg }).catch(() => {});
    } catch (_) {}
  }

  return cfg;
})();
