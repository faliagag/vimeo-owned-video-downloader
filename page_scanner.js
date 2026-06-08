/* page_scanner.js v9.3
 * Corre en world:MAIN en la pagina del usuario (not in iframes)
 * Escanea iframes de Vimeo y recolecta configs capturados por vimeo_interceptor.js
 */
(function () {
  'use strict';
  if (window.__vimeoScannerV93) return;
  window.__vimeoScannerV93 = true;

  // Almacen de configs capturados desde los iframes
  window.__VIMEO_PAGE_CONFIGS__ = window.__VIMEO_PAGE_CONFIGS__ || {};

  // Escuchar postMessages de los iframes de Vimeo
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (d && d.__vimeoExt && d.type === 'VIMEO_CONFIG_CAPTURED' && d.videoId && d.config) {
      window.__VIMEO_PAGE_CONFIGS__[String(d.videoId)] = d.config;
    }
  });

  function extractVimeoId(src) {
    if (!src) return null;
    // player.vimeo.com/video/ID
    let m = src.match(/player\.vimeo\.com\/video\/(\d+)/);
    if (m) return m[1];
    // vimeo.com/ID
    m = src.match(/vimeo\.com\/(\d+)/);
    if (m) return m[1];
    return null;
  }

  function scanEmbeds() {
    const results = [];
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach(function (iframe) {
      const src = iframe.src || iframe.getAttribute('data-src') || iframe.getAttribute('data-lazy-src') || '';
      const id = extractVimeoId(src);
      if (!id) return;
      const entry = { vimeoId: id, src: src, hasConfig: false, config: null };
      // Intentar leer el config capturado por el interceptor
      if (window.__VIMEO_PAGE_CONFIGS__[id]) {
        entry.hasConfig = true;
        entry.config = window.__VIMEO_PAGE_CONFIGS__[id];
      }
      // Intentar leer directamente del contentWindow del iframe (same-origin no aplica aqui,
      // pero si el iframe es cross-origin esto lanzara excepcion silenciosa)
      if (!entry.config) {
        try {
          const iw = iframe.contentWindow;
          if (iw && iw.__VIMEO_CAPTURED_CONFIG__) {
            const cfg = Object.values(iw.__VIMEO_CAPTURED_CONFIG__)[0];
            if (cfg) { entry.hasConfig = true; entry.config = cfg; }
          }
        } catch (_) {}
      }
      results.push(entry);
    });
    return results;
  }

  // Funcion que llama el background
  window.__scanVimeoEmbedsNow = function () {
    return scanEmbeds();
  };

  // Funcion para obtener config de un video especifico
  window.__getVimeoConfig = function (videoId) {
    const vid = String(videoId);
    if (window.__VIMEO_PAGE_CONFIGS__[vid]) {
      return { config: window.__VIMEO_PAGE_CONFIGS__[vid], source: 'postMessage' };
    }
    // Buscar en todos los iframes de Vimeo el que coincida
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      const src = iframe.src || '';
      if (!src.includes(vid)) continue;
      try {
        const iw = iframe.contentWindow;
        if (iw && iw.__VIMEO_CAPTURED_CONFIG__ && iw.__VIMEO_CAPTURED_CONFIG__[vid]) {
          return { config: iw.__VIMEO_CAPTURED_CONFIG__[vid], source: 'contentWindow' };
        }
      } catch (_) {}
    }
    return { config: null, error: 'No capturado aun' };
  };

  // Exponer embeds para el popup
  window.__VIMEO_EMBEDS__ = [];
  function refreshEmbeds() {
    window.__VIMEO_EMBEDS__ = scanEmbeds();
  }
  refreshEmbeds();
  // Refrescar cuando el DOM cambie (sitios SPA)
  const obs = new MutationObserver(function () { refreshEmbeds(); });
  obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
