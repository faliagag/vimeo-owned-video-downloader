/* page_scanner.js v8.3
 * Corre en world:MAIN (acceso directo a variables JS del player Vimeo).
 * Expone:
 *   window.__scanVimeoEmbedsNow() -> array de embeds detectados
 *   window.__getVimeoConfig(videoId) -> { config, error }
 */
'use strict';

(function() {

function getVimeoIdFromSrc(src) {
  try {
    const u = new URL(src);
    const m = u.pathname.match(/\/(video\/)?(\d{5,12})/);
    return m ? m[2] : null;
  } catch (_) { return null; }
}

function getConfigFromFrame(frameEl) {
  try {
    const w = frameEl.contentWindow;
    if (!w) return null;
    // Intentar varios candidatos donde Vimeo guarda el config
    const candidates = [
      w.playerConfig,
      w.__playerConfig,
      w.Vimeo?.playerConfig,
      w.config,
    ];
    for (const c of candidates) {
      if (c && c.request && c.video) return c;
    }
    // Buscar en variables del scope
    for (const key of Object.keys(w)) {
      try {
        const val = w[key];
        if (val && typeof val === 'object' && val.request && val.video && val.request.files) return val;
      } catch (_) {}
    }
    return null;
  } catch (_) { return null; }
}

window.__scanVimeoEmbedsNow = function() {
  const iframes = Array.from(document.querySelectorAll('iframe'));
  const results = [];
  const seenIds = new Set();

  for (const iframe of iframes) {
    const src = iframe.src || iframe.getAttribute('data-src') || '';
    if (!src.includes('vimeo.com')) continue;
    const vid = getVimeoIdFromSrc(src);
    if (!vid || seenIds.has(vid)) continue;
    seenIds.add(vid);

    const cfg = getConfigFromFrame(iframe);
    const title = cfg?.video?.title || iframe.title || iframe.getAttribute('title') || '';
    const hasProgressive = !!(cfg?.request?.files?.progressive?.length || cfg?.files?.progressive?.length);
    const hasHls = !!(cfg?.request?.files?.hls || cfg?.files?.hls);

    results.push({
      vimeoId: vid,
      src,
      title,
      hasProgressiveFiles: hasProgressive,
      hasHls,
      configFound: !!cfg
    });
  }

  // Guardar en global para acceso posterior
  window.__VIMEO_EMBEDS__ = results;
  return results;
};

window.__getVimeoConfig = function(videoId) {
  const iframes = Array.from(document.querySelectorAll('iframe'));
  for (const iframe of iframes) {
    const src = iframe.src || iframe.getAttribute('data-src') || '';
    if (!src.includes('vimeo.com')) continue;
    const vid = getVimeoIdFromSrc(src);
    if (vid !== String(videoId)) continue;
    const cfg = getConfigFromFrame(iframe);
    if (cfg) return { config: cfg, error: null };
    return { config: null, error: 'iframe encontrado pero sin acceso al playerConfig (¿cross-origin?)' };
  }
  return { config: null, error: 'No se encontró iframe con ID ' + videoId };
};

// Escaneo inicial al cargar
try { window.__scanVimeoEmbedsNow(); } catch(_) {}

})();
