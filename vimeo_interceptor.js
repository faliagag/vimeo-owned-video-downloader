/* vimeo_interceptor.js v9.3
 * Corre en world:MAIN dentro de player.vimeo.com (all_frames:true)
 * Intercepta XHR y fetch para capturar el playerConfig antes de que Vimeo lo procese.
 * Expone el resultado en window.__VIMEO_CAPTURED_CONFIG__ y lo envia al background.
 */
(function () {
  'use strict';
  if (window.__vimeoInterceptorV93) return;
  window.__vimeoInterceptorV93 = true;

  function extractVideoId() {
    try {
      const m = location.pathname.match(/\/video\/(\d+)/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  function isConfigUrl(url) {
    return typeof url === 'string' && /player\.vimeo\.com\/video\/\d+\/config/.test(url);
  }

  function tryParseConfig(text) {
    try {
      const j = JSON.parse(text);
      if (j && j.request && j.request.files) return j;
    } catch (_) {}
    return null;
  }

  function broadcast(config) {
    const videoId = extractVideoId() || (config && config.video && String(config.video.id)) || '';
    window.__VIMEO_CAPTURED_CONFIG__ = window.__VIMEO_CAPTURED_CONFIG__ || {};
    window.__VIMEO_CAPTURED_CONFIG__[videoId] = config;
    // Enviar al background via chrome.runtime si esta disponible
    try {
      chrome.runtime.sendMessage({
        type: '__VIMEO_CONFIG_FROM_FRAME__',
        videoId: videoId,
        config: config
      }).catch(() => {});
    } catch (_) {}
    // Tambien disparar un CustomEvent para que page_scanner.js lo lea desde la pagina padre
    try {
      window.top.postMessage({
        __vimeoExt: true,
        type: 'VIMEO_CONFIG_CAPTURED',
        videoId: videoId,
        config: config
      }, '*');
    } catch (_) {}
  }

  /* --- Interceptar XMLHttpRequest --- */
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '';
    const origOpen = xhr.open.bind(xhr);
    const origSend = xhr.send.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      _url = url || '';
      return origOpen(method, url, ...rest);
    };
    xhr.send = function (...args) {
      if (isConfigUrl(_url)) {
        xhr.addEventListener('load', function () {
          try {
            const cfg = tryParseConfig(xhr.responseText);
            if (cfg) broadcast(cfg);
          } catch (_) {}
        }, { once: true });
      }
      return origSend(...args);
    };
    // Proxy para que el codigo de Vimeo pueda seguir accediendo a propiedades normalmente
    return new Proxy(xhr, {
      get(t, p) { const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; },
      set(t, p, v) { try { t[p] = v; } catch (_) {} return true; }
    });
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  try { window.XMLHttpRequest = PatchedXHR; } catch (_) {}

  /* --- Interceptar fetch --- */
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const response = await origFetch.call(this, input, init);
    if (isConfigUrl(url)) {
      try {
        const clone = response.clone();
        clone.text().then(text => {
          const cfg = tryParseConfig(text);
          if (cfg) broadcast(cfg);
        }).catch(() => {});
      } catch (_) {}
    }
    return response;
  };

  /* --- Leer config si ya fue cargado como variable global --- */
  function tryReadGlobal() {
    const candidates = ['playerConfig', '__playerConfig', 'config', 'vimeoPlayerConfig'];
    for (const k of candidates) {
      try {
        const v = window[k];
        if (v && v.request && v.request.files && v.video && v.video.id) {
          broadcast(v);
          return true;
        }
      } catch (_) {}
    }
    // Busqueda profunda solo en el scope global de primero nivel
    try {
      for (const k of Object.keys(window)) {
        const v = window[k];
        if (v && typeof v === 'object' && v.request && v.request.files && v.video && v.video.id) {
          broadcast(v);
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  // Intentar inmediatamente y luego en distintos momentos del ciclo de vida
  tryReadGlobal();
  document.addEventListener('DOMContentLoaded', tryReadGlobal, { once: true });
  window.addEventListener('load', tryReadGlobal, { once: true });
  setTimeout(tryReadGlobal, 500);
  setTimeout(tryReadGlobal, 1500);
  setTimeout(tryReadGlobal, 3000);
})();
