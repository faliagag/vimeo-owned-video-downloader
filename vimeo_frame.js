/* vimeo_frame.js v9.0
 * Escucha postMessages del interceptor y los almacena en window.__vimeoInterceptedConfigs
 * Se inyecta en la página principal (no en el iframe)
 */
'use strict';
(function () {
  if (window.__VIMEO_FRAME_LISTENER_V90__) return;
  window.__VIMEO_FRAME_LISTENER_V90__ = true;

  if (!window.__vimeoInterceptedConfigs) window.__vimeoInterceptedConfigs = {};

  window.addEventListener('message', function (ev) {
    try {
      const d = ev.data;
      if (!d || !d.__vimeoExtConfig) return;
      const vid = String(d.videoId || '');
      if (!vid) return;
      window.__vimeoInterceptedConfigs[vid] = d.config;
      // Disparar re-escaneo
      if (typeof window.__scanVimeoEmbedsNow === 'function') {
        window.__scanVimeoEmbedsNow();
      }
    } catch(_) {}
  });
})();
