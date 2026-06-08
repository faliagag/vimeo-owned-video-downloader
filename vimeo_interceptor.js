/* vimeo_interceptor.js v9.0
 * Corre en world:MAIN dentro de player.vimeo.com
 * Captura playerConfig interceptando JSON.parse y window.playerConfig
 * Luego lo comunica al padre vía postMessage
 */
'use strict';
(function () {
  if (window.__VIMEO_INTERCEPTOR_V90__) return;
  window.__VIMEO_INTERCEPTOR_V90__ = true;

  function broadcast(cfg) {
    if (!cfg || !cfg.video || !cfg.request) return;
    const vid = String(cfg.video.id || cfg.video.clip_id || '');
    if (!vid) return;
    try {
      window.top.postMessage({ __vimeoExtConfig: true, videoId: vid, config: cfg }, '*');
    } catch(_) {
      try { window.parent.postMessage({ __vimeoExtConfig: true, videoId: vid, config: cfg }, '*'); } catch(_) {}
    }
  }

  // Interceptar JSON.parse para capturar el momento en que se parsea playerConfig
  const origParse = JSON.parse;
  JSON.parse = function(text) {
    const result = origParse.apply(this, arguments);
    try {
      if (result && result.request && result.video && result.request.files) {
        broadcast(result);
      }
    } catch(_) {}
    return result;
  };

  // Interceptar asignación de window.playerConfig
  try {
    let _cfg = window.playerConfig;
    Object.defineProperty(window, 'playerConfig', {
      get() { return _cfg; },
      set(v) { _cfg = v; broadcast(v); },
      configurable: true
    });
  } catch(_) {}

  // Chequeo diferido por si ya estaba asignado
  setTimeout(() => {
    try {
      if (window.playerConfig) broadcast(window.playerConfig);
    } catch(_) {}
    // Buscar en todas las variables globales
    for (const k of Object.keys(window)) {
      try {
        const v = window[k];
        if (v && typeof v === 'object' && v.request?.files && v.video?.id) broadcast(v);
      } catch(_) {}
    }
  }, 800);
})();
