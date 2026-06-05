(function () {
  /* ---- utilidades ---- */
  function normalizeUrl(url) {
    try { return new URL(url, location.href).href; } catch { return url || ''; }
  }
  function extractVimeoId(url) {
    if (!url) return null;
    for (const p of [/player\.vimeo\.com\/video\/(\d+)/, /vimeo\.com\/video\/(\d+)/, /vimeo\.com\/(\d+)/]) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }
  function textAround(el) {
    const options = [];
    ['title', 'aria-label', 'data-title', 'data-video-title'].forEach(a => {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) options.push(v.trim());
    });
    const wrap = el.closest && el.closest('figure, .video, .video-item, .embed, .player, article, section, div');
    const h = wrap && wrap.querySelector && wrap.querySelector('h1,h2,h3,h4,strong,b');
    if (h?.textContent) options.push(h.textContent.trim());
    return options.find(Boolean) || '';
  }

  /* ---- detectores ---- */
  function fromIframes() {
    return [...document.querySelectorAll('iframe')].map(f => {
      const src = normalizeUrl(f.getAttribute('src') || f.getAttribute('data-src') || '');
      if (!/player\.vimeo\.com|vimeo\.com/.test(src)) return null;
      return { kind: 'iframe', detectedBy: 'iframe', src, vimeoId: extractVimeoId(src), titleHint: textAround(f) };
    }).filter(Boolean);
  }
  function fromAttrs() {
    return [...document.querySelectorAll('a[href*="vimeo.com"], [data-vimeo-id], [data-video-id], [data-vimeo-url]')].map(el => {
      const raw = el.getAttribute('href') || el.getAttribute('data-vimeo-url') || '';
      const id = el.getAttribute('data-vimeo-id') || el.getAttribute('data-video-id') || extractVimeoId(raw);
      if (!raw && !id) return null;
      return { kind: 'attr', detectedBy: 'link/data-attr', src: normalizeUrl(raw || `https://player.vimeo.com/video/${id}`), vimeoId: id, titleHint: textAround(el) };
    }).filter(v => v && (v.vimeoId || /vimeo\.com/.test(v.src)));
  }
  function fromJsonLd() {
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      const txt = s.textContent || '';
      [...txt.matchAll(/vimeo\.com\/(?:video\/)?(\d+)/g)].forEach(m =>
        out.push({ kind: 'jsonld', detectedBy: 'json-ld', src: `https://player.vimeo.com/video/${m[1]}`, vimeoId: m[1], titleHint: '' })
      );
    });
    return out;
  }
  function unique(items) {
    const map = new Map();
    items.forEach(item => {
      const key = item.vimeoId || item.src;
      if (key && !map.has(key)) map.set(key, { ...item, pageUrl: location.href });
    });
    return [...map.values()];
  }
  function scanVimeoEmbedsNow() {
    const found = unique([...fromIframes(), ...fromAttrs(), ...fromJsonLd()]);
    window.__VIMEO_EMBEDS__ = found;
    return found;
  }
  window.__scanVimeoEmbedsNow = scanVimeoEmbedsNow;
  scanVimeoEmbedsNow();
  new MutationObserver(() => scanVimeoEmbedsNow()).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['src', 'href', 'data-src', 'data-vimeo-id', 'data-video-id', 'data-vimeo-url']
  });

  /* ---- FIX 403: fetch desde contexto de página con Referer correcto ---- */
  // El background.js (service worker) NO puede enviar el Referer del sitio.
  // Por eso inyectamos la lógica de fetch aquí, en el contexto de la página,
  // donde el navegador adjunta automáticamente el Referer correcto.
  window.__vimeoFetchConfig = async function(videoId) {
    async function tryFetch(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    }
    // 1. Intentar data-config-url desde el HTML del player
    try {
      const html = await (await tryFetch(`https://player.vimeo.com/video/${videoId}`, { credentials: 'include' })).text();
      const dcUrl = (html.match(/data-config-url="([^"]+)"/i) || [])[1];
      if (dcUrl) {
        const cfg = await (await tryFetch(dcUrl.replace(/&amp;/g, '&'), { credentials: 'include' })).json();
        return { ok: true, config: cfg };
      }
      // 2. config inline
      const inlineMatch = html.match(/(?:window\.playerConfig\s*=\s*|var\s+config\s*=\s*)(\{[\s\S]{10,5000}?\});/);
      if (inlineMatch) {
        try { return { ok: true, config: JSON.parse(inlineMatch[1]) }; } catch(_) {}
      }
      // 3. progressive inline
      const progMatch = html.match(/"progressive"\s*:\s*(\[[\s\S]{2,4000}?\])/);
      if (progMatch) {
        try {
          return { ok: true, config: { request: { files: { progressive: JSON.parse(progMatch[1]) } }, video: { title: 'video-' + videoId } } };
        } catch(_) {}
      }
    } catch(e) {
      // si falla el HTML, intentar el endpoint /config directo
    }
    // 4. Endpoint /config directo
    try {
      const cfg = await (await tryFetch(`https://player.vimeo.com/video/${videoId}/config`, { credentials: 'include' })).json();
      return { ok: true, config: cfg };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  // Escucha mensajes desde el background para ejecutar el fetch en contexto de página
  window.addEventListener('message', async function(evt) {
    if (!evt.data || evt.data.__vimeoExtCmd !== 'FETCH_CONFIG') return;
    const { videoId, reqId } = evt.data;
    const result = await window.__vimeoFetchConfig(videoId);
    window.postMessage({ __vimeoExtResp: 'FETCH_CONFIG_RESULT', reqId, ...result }, '*');
  });
})();
