/* vimeo_interceptor.js v8.3
 * Corre dentro del iframe de player.vimeo.com en world:MAIN
 * Intercepta window.playerConfig y lo expone a la página padre
 * via postMessage para cuando same-origin falla.
 */
'use strict';

(function() {
  if (window.__VIMEO_INTERCEPTOR__) return;
  window.__VIMEO_INTERCEPTOR__ = true;

  function tryExpose(cfg) {
    if (!cfg || !cfg.video || !cfg.request) return;
    try {
      window.parent.postMessage({
        type: '__VIMEO_CONFIG__',
        videoId: String(cfg.video.id || ''),
        title:   cfg.video.title || '',
        config:  JSON.parse(JSON.stringify(cfg))
      }, '*');
    } catch(e) {
      // Si el config no es serializable, enviar solo metadatos
      window.parent.postMessage({
        type: '__VIMEO_CONFIG__',
        videoId: String(cfg.video?.id || ''),
        title:   cfg.video?.title || '',
        config:  null,
        error:   'no_serializable'
      }, '*');
    }
  }

  // Intentar exponer inmediatamente si ya existe
  if (window.playerConfig) tryExpose(window.playerConfig);

  // Proxy para capturar asignación futura
  let _cfg = window.playerConfig || null;
  try {
    Object.defineProperty(window, 'playerConfig', {
      get: function() { return _cfg; },
      set: function(v) { _cfg = v; tryExpose(v); },
      configurable: true
    });
  } catch(_) {}

  // Escuchar postMessage de la extensión solicitando config
  window.addEventListener('message', function(e) {
    if (e.data?.type === '__REQUEST_VIMEO_CONFIG__') {
      tryExpose(_cfg || window.playerConfig);
    }
  });

})();
