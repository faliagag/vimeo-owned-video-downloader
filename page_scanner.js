/* page_scanner.js v8.5
 * Busca iframes Vimeo en:
 *  - src, data-src, data-lazy-src, data-url, data-embed-url
 *  - Shadow DOM (recursivo)
 *  - Atributos allow="autoplay" con URL vimeo
 * MutationObserver para iframes que se agregan dinámicamente.
 */
'use strict';

(function () {
  if (window.__VIMEO_SCANNER_V85__) return;
  window.__VIMEO_SCANNER_V85__ = true;

  const VIMEO_ATTRS = ['src', 'data-src', 'data-lazy-src', 'data-url', 'data-embed-url', 'data-original'];

  function getVimeoIdFromStr(str) {
    if (!str) return null;
    try {
      // URL completa
      if (str.startsWith('http')) {
        const u = new URL(str);
        if (!u.hostname.includes('vimeo')) return null;
        const m = u.pathname.match(/\/(video\/)?(\d{5,12})/);
        return m ? m[2] : null;
      }
    } catch (_) {}
    // Solo número o path
    const m = String(str).match(/(\d{5,12})/);
    return m ? m[1] : null;
  }

  function getVimeoSrcFromEl(el) {
    for (const attr of VIMEO_ATTRS) {
      const val = el.getAttribute(attr);
      if (val && val.includes('vimeo')) return val;
    }
    return null;
  }

  function getConfigFromFrame(frameEl) {
    try {
      const w = frameEl.contentWindow;
      if (!w) return null;
      const candidates = [
        w.playerConfig,
        w.__playerConfig,
        w.Vimeo?.playerConfig,
        w.config,
      ];
      for (const c of candidates) {
        if (c && c.request && c.video) return c;
      }
      for (const key of Object.keys(w)) {
        try {
          const val = w[key];
          if (val && typeof val === 'object' && val.request && val.video && val.request.files) return val;
        } catch (_) {}
      }
      return null;
    } catch (_) { return null; }
  }

  // Recolectar todos los iframes incluyendo shadow DOM
  function collectAllIframes(root, results) {
    root = root || document;
    try {
      root.querySelectorAll('iframe').forEach(f => results.push(f));
      // Shadow roots
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) collectAllIframes(el.shadowRoot, results);
      });
    } catch (_) {}
  }

  window.__scanVimeoEmbedsNow = function () {
    const allIframes = [];
    collectAllIframes(document, allIframes);

    const results = [];
    const seenIds = new Set();

    for (const iframe of allIframes) {
      const src = getVimeoSrcFromEl(iframe);
      if (!src) continue;
      const vid = getVimeoIdFromStr(src);
      if (!vid || seenIds.has(vid)) continue;
      seenIds.add(vid);

      const cfg   = getConfigFromFrame(iframe);
      const title = cfg?.video?.title || iframe.title || iframe.getAttribute('title') || '';
      const hasProgressive = !!(cfg?.request?.files?.progressive?.length || cfg?.files?.progressive?.length);
      const hasHls  = !!(cfg?.request?.files?.hls || cfg?.files?.hls);

      results.push({
        vimeoId: vid,
        src,
        title,
        hasProgressiveFiles: hasProgressive,
        hasHls,
        configFound: !!cfg
      });
    }

    window.__VIMEO_EMBEDS__ = results;
    return results;
  };

  window.__getVimeoConfig = function (videoId) {
    const allIframes = [];
    collectAllIframes(document, allIframes);
    for (const iframe of allIframes) {
      const src = getVimeoSrcFromEl(iframe);
      if (!src) continue;
      const vid = getVimeoIdFromStr(src);
      if (vid !== String(videoId)) continue;
      const cfg = getConfigFromFrame(iframe);
      if (cfg) return { config: cfg, error: null };
      return { config: null, error: 'iframe encontrado pero sin acceso al playerConfig (¿cross-origin o aún cargando?)' };
    }
    return { config: null, error: 'No se encontró iframe con ID ' + videoId };
  };

  // MutationObserver: detectar iframes que se agregan después
  const observer = new MutationObserver(() => {
    try { window.__scanVimeoEmbedsNow(); } catch (_) {}
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Escaneo inicial
  try { window.__scanVimeoEmbedsNow(); } catch (_) {}

})();
