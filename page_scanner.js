/* page_scanner.js v7.0
 * Corre en world:MAIN de cada pestaña.
 * Detecta iframes de Vimeo y expone funciones para el SW.
 */
'use strict';

(function () {
  // Almacén de configs capturadas por el interceptor
  if (!window.__VIMEO_CONFIGS__) window.__VIMEO_CONFIGS__ = {};
  if (!window.__VIMEO_EMBEDS__) window.__VIMEO_EMBEDS__ = [];

  // ─── Escanear iframes de Vimeo en el DOM ───────────────────────────────────
  window.__scanVimeoEmbedsNow = function () {
    const frames = document.querySelectorAll('iframe[src*="vimeo"], iframe[data-src*="vimeo"]');
    const embeds = [];
    frames.forEach(f => {
      const src = f.src || f.dataset.src || '';
      const m = src.match(/vimeo\.com\/video\/(\d+)/);
      if (!m) return;
      const vimeoId = m[1];
      // Buscar título: padre más cercano con aria-label, data-title, o h2/h3
      let titleHint = '';
      let el = f.parentElement;
      for (let d = 0; d < 5 && el; d++, el = el.parentElement) {
        const t = el.getAttribute('aria-label') || el.getAttribute('data-title') || el.getAttribute('title');
        if (t) { titleHint = t; break; }
        const h = el.querySelector('h1,h2,h3,h4');
        if (h) { titleHint = h.textContent.trim(); break; }
      }
      embeds.push({
        vimeoId,
        src,
        titleHint: titleHint || 'Video ' + vimeoId,
        detectedBy: 'iframe-scan'
      });
    });
    window.__VIMEO_EMBEDS__ = embeds;
    return embeds;
  };

  // ─── Obtener config playerConfig del iframe ────────────────────────────────
  window.__getVimeoConfig = async function (videoId) {
    // 1. ¿Ya fue capturado por el interceptor?
    if (window.__VIMEO_CONFIGS__[videoId]) {
      return { config: window.__VIMEO_CONFIGS__[videoId] };
    }
    // 2. Intentar fetch directo a player.vimeo.com/video/{id}/config
    // (funciona para videos públicos; para privados necesita el token del iframe)
    const iframe = document.querySelector(`iframe[src*="/${videoId}"]`);
    const iframeSrc = iframe?.src || '';
    // Extraer parámetros del iframe (h, token, etc.)
    const iframeUrl = iframeSrc ? new URL(iframeSrc) : null;
    const configUrls = [
      `https://player.vimeo.com/video/${videoId}/config`,
    ];
    if (iframeUrl) {
      const params = new URLSearchParams();
      for (const [k, v] of iframeUrl.searchParams) params.set(k, v);
      configUrls.push(`https://player.vimeo.com/video/${videoId}/config?${params.toString()}`);
    }
    for (const url of configUrls) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (r.ok) {
          const json = await r.json();
          if (json?.request || json?.video) {
            window.__VIMEO_CONFIGS__[videoId] = json;
            return { config: json };
          }
        }
      } catch (_) {}
    }
    // 3. Intentar postMessage al iframe para obtener config
    if (iframe) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ config: null, error: 'Sin respuesta del iframe en 5s.' }), 5000);
        const handler = (e) => {
          try {
            const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
            if (d?.event === 'ready' || d?.method) return;
            if (d?.config || d?.request) {
              clearTimeout(timeout);
              window.removeEventListener('message', handler);
              const cfg = d.config || d;
              window.__VIMEO_CONFIGS__[videoId] = cfg;
              resolve({ config: cfg });
            }
          } catch (_) {}
        };
        window.addEventListener('message', handler);
        iframe.contentWindow?.postMessage(JSON.stringify({ method: 'getVideoEmbedCode' }), '*');
      });
    }
    return { config: null, error: 'No se encontró config para videoId ' + videoId + '.' };
  };

  // Ejecutar escaneo inicial
  window.__scanVimeoEmbedsNow();

  // Re-escanear en mutaciones DOM (para SPAs)
  const obs = new MutationObserver(() => window.__scanVimeoEmbedsNow());
  obs.observe(document.body, { childList: true, subtree: true });
})();
