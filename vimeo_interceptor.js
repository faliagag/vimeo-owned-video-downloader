/* vimeo_interceptor.js v7.0
 * Corre en world:MAIN dentro de player.vimeo.com
 * Intercepta la asignación de window.playerConfig y window.__config
 * para capturar el objeto de configuración completo.
 */
'use strict';

(function () {
  if (window.__VIMEO_INTERCEPTOR_ACTIVE__) return;
  window.__VIMEO_INTERCEPTOR_ACTIVE__ = true;

  function extractVideoId(url) {
    try {
      const m = (url || window.location.href).match(/vimeo\.com\/video\/(\d+)/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  function sendConfigUp(config) {
    if (!config) return;
    const vid = config?.video?.id || extractVideoId();
    if (!vid) return;
    // Notificar al padre (la página que tiene page_scanner.js)
    try {
      window.top.postMessage({ type: '__VIMEO_CONFIG_INTERCEPTED__', videoId: String(vid), config }, '*');
    } catch (_) {}
    // Guardar local
    try {
      window.__CAPTURED_CONFIG__ = config;
    } catch (_) {}
  }

  // Interceptar playerConfig y __config
  ['playerConfig', '__config', '__initialConfig__'].forEach(key => {
    let _val = window[key];
    Object.defineProperty(window, key, {
      get() { return _val; },
      set(v) {
        _val = v;
        if (v && typeof v === 'object') sendConfigUp(v);
      },
      configurable: true
    });
    if (_val) sendConfigUp(_val);
  });

  // Interceptar fetch para capturar /config
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch(...args);
    const url = (args[0]?.url || args[0] || '').toString();
    if (/\/config/.test(url)) {
      try {
        const clone = res.clone();
        clone.json().then(j => { if (j?.request || j?.video) sendConfigUp(j); }).catch(() => {});
      } catch (_) {}
    }
    return res;
  };

  // Interceptar XMLHttpRequest para /config
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url, ...rest) {
    this.__vimeoUrl = url;
    return _open.call(this, m, url, ...rest);
  };
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (/\/config/.test(this.__vimeoUrl || '')) {
      this.addEventListener('load', () => {
        try {
          const j = JSON.parse(this.responseText);
          if (j?.request || j?.video) sendConfigUp(j);
        } catch (_) {}
      });
    }
    return _send.call(this, ...args);
  };
})();
