// interceptor.js — Se inyecta en world:MAIN para capturar la config de Vimeo
// sin hacer fetch a la API (lo que causaria 403).
// Funciona interceptando XMLHttpRequest y fetch del player de Vimeo.

(function () {
  if (window.__vimeoInterceptorActive) return;
  window.__vimeoInterceptorActive = true;
  window.__VIMEO_PAGE_CONFIGS__ = window.__VIMEO_PAGE_CONFIGS__ || {};

  // ── Interceptar XMLHttpRequest ──────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '';
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      _url = url;
      return origOpen(method, url, ...rest);
    };
    const origSend = xhr.send.bind(xhr);
    xhr.send = function (...args) {
      xhr.addEventListener('load', function () {
        try {
          if (_url && _url.includes('player.vimeo.com') && _url.includes('/config')) {
            const data = JSON.parse(xhr.responseText);
            const vid = data?.video?.id || _url.match(/\/video\/(\d+)/)?.[1];
            if (vid) {
              window.__VIMEO_PAGE_CONFIGS__[String(vid)] = data;
              console.debug('[VimeoInterceptor] Config capturada via XHR, ID:', vid);
            }
          }
        } catch (e) {}
      });
      return origSend(...args);
    };
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ── Interceptar fetch ───────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const resp = await origFetch.call(window, input, init);
    try {
      if (url && url.includes('player.vimeo.com') && url.includes('/config')) {
        const clone = resp.clone();
        clone.json().then(data => {
          const vid = data?.video?.id || url.match(/\/video\/(\d+)/)?.[1];
          if (vid) {
            window.__VIMEO_PAGE_CONFIGS__[String(vid)] = data;
            console.debug('[VimeoInterceptor] Config capturada via fetch, ID:', vid);
          }
        }).catch(() => {});
      }
    } catch (e) {}
    return resp;
  };

  // ── Leer config del script#player-config (player.vimeo.com) ──────────
  function tryReadInlineConfig() {
    try {
      const el = document.querySelector('script#player-config');
      if (el) {
        const data = JSON.parse(el.textContent);
        const vid = data?.video?.id;
        if (vid) {
          window.__VIMEO_PAGE_CONFIGS__[String(vid)] = data;
          console.debug('[VimeoInterceptor] Config leida del DOM, ID:', vid);
        }
      }
    } catch (e) {}
  }
  tryReadInlineConfig();
  document.addEventListener('DOMContentLoaded', tryReadInlineConfig);

  console.debug('[VimeoInterceptor] Activo');
})();
