/* page_scanner.js v8.0 */
'use strict';
(function () {
  if (!window.__VIMEO_CONFIGS__) window.__VIMEO_CONFIGS__ = {};
  if (!window.__VIMEO_EMBEDS__) window.__VIMEO_EMBEDS__ = [];

  // Recibir configs interceptadas desde iframes de Vimeo
  window.addEventListener('message', (e) => {
    if (e.data?.type === '__VIMEO_CONFIG_INTERCEPTED__') {
      const { videoId, config } = e.data;
      if (videoId && config) window.__VIMEO_CONFIGS__[videoId] = config;
    }
  });

  window.__scanVimeoEmbedsNow = function () {
    const frames = document.querySelectorAll('iframe[src*="vimeo"], iframe[data-src*="vimeo"]');
    const embeds = [];
    frames.forEach(f => {
      const src = f.src || f.dataset.src || '';
      const m = src.match(/vimeo\.com\/video\/(\d+)/);
      if (!m) return;
      const vimeoId = m[1];
      let titleHint = '';
      let el = f.parentElement;
      for (let d = 0; d < 6 && el; d++, el = el.parentElement) {
        const t = el.getAttribute('aria-label') || el.getAttribute('data-title') || el.getAttribute('title');
        if (t) { titleHint = t; break; }
        const h = el.querySelector('h1,h2,h3,h4');
        if (h?.textContent?.trim()) { titleHint = h.textContent.trim(); break; }
      }
      embeds.push({ vimeoId, src, titleHint: titleHint || 'Video ' + vimeoId, detectedBy: 'iframe-scan' });
    });
    window.__VIMEO_EMBEDS__ = embeds;
    return embeds;
  };

  window.__getVimeoConfig = async function (videoId) {
    if (window.__VIMEO_CONFIGS__[videoId]) return { config: window.__VIMEO_CONFIGS__[videoId] };
    const iframe = document.querySelector(`iframe[src*="/${videoId}"]`);
    const iframeSrc = iframe?.src || '';
    const iframeUrl = iframeSrc ? new URL(iframeSrc) : null;
    const configUrls = [`https://player.vimeo.com/video/${videoId}/config`];
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
          if (json?.request || json?.video) { window.__VIMEO_CONFIGS__[videoId] = json; return { config: json }; }
        }
      } catch (_) {}
    }
    if (iframe) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ config: null, error: 'Sin respuesta del iframe en 5s.' }), 5000);
        const handler = (e) => {
          try {
            const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
            if (d?.config || d?.request) {
              clearTimeout(timeout); window.removeEventListener('message', handler);
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
    return { config: null, error: 'No se encontró config para videoId ' + videoId };
  };

  window.__scanVimeoEmbedsNow();
  const obs = new MutationObserver(() => window.__scanVimeoEmbedsNow());
  obs.observe(document.body, { childList: true, subtree: true });
})();
