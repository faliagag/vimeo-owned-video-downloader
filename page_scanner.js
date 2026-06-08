/* page_scanner.js v9.0
 * Detecta iframes Vimeo usando TODAS las formas posibles:
 * 1. src directo
 * 2. data-src / data-lazy-src / data-url / data-embed-url / data-original / data-vimeo-id
 * 3. Atributo allow con player.vimeo.com
 * 4. Shadow DOM recursivo
 * 5. MutationObserver para carga dinámica
 * 6. Búsqueda en el HTML completo de la página (regex)
 * 7. window.__vimeoEmbeds inyectado por el interceptor del frame
 */
'use strict';
(function () {
  if (window.__VIMEO_SCANNER_V90__) return;
  window.__VIMEO_SCANNER_V90__ = true;

  const ATTRS = ['src','data-src','data-lazy-src','data-url','data-embed-url',
                 'data-original','data-vimeo-id','data-vimeo-url'];

  function extractId(str) {
    if (!str) return null;
    // ID numérico puro
    if (/^\d{5,12}$/.test(str.trim())) return str.trim();
    try {
      const u = new URL(str);
      if (u.hostname.includes('vimeo')) {
        const m = u.pathname.match(/\/(video\/)?(\d{5,12})/);
        if (m) return m[2];
      }
    } catch(_) {}
    const m = str.match(/(?:vimeo\.com\/(?:video\/)?|player\.vimeo\.com\/video\/)(\d{5,12})/);
    return m ? m[1] : null;
  }

  function getVimeoAttr(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && (v.includes('vimeo') || /^\d{5,12}$/.test(v.trim()))) return v;
    }
    return null;
  }

  function collectIframes(root, out) {
    try {
      (root || document).querySelectorAll('iframe,div[data-vimeo-id],div[data-src*="vimeo"]').forEach(el => {
        const val = getVimeoAttr(el);
        if (val) out.push({ el, val });
      });
      (root || document).querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) collectIframes(el.shadowRoot, out);
      });
    } catch(_) {}
  }

  function getPlayerConfig(frameEl) {
    try {
      const w = frameEl.contentWindow;
      if (!w) return null;
      // Intento 1: variables conocidas
      for (const k of ['playerConfig','__playerConfig','config','__config','_config']) {
        try {
          const v = w[k];
          if (v && v.request && v.video) return v;
        } catch(_) {}
      }
      // Intento 2: recorrer todas las variables
      for (const k of Object.keys(w)) {
        try {
          const v = w[k];
          if (v && typeof v === 'object' && v.request?.files && v.video?.id) return v;
        } catch(_) {}
      }
    } catch(_) {}
    return null;
  }

  window.__scanVimeoEmbedsNow = function () {
    const found = [];
    const seenIds = new Set();

    // Estrategia A: iframes/divs en DOM
    const collected = [];
    collectIframes(document, collected);
    for (const { el, val } of collected) {
      const vid = extractId(val);
      if (!vid || seenIds.has(vid)) continue;
      seenIds.add(vid);
      const cfg   = el.tagName === 'IFRAME' ? getPlayerConfig(el) : null;
      const title = cfg?.video?.title || el.title || el.getAttribute('title') || '';
      found.push({
        vimeoId: vid,
        src: val,
        title,
        configFound: !!cfg,
        hasProgressiveFiles: !!(cfg?.request?.files?.progressive?.length),
        hasHls: !!(cfg?.request?.files?.hls),
        hasDash: !!(cfg?.request?.files?.dash),
        strategy: 'dom'
      });
    }

    // Estrategia B: regex sobre el HTML completo
    try {
      const html = document.documentElement.innerHTML;
      const re = /(?:player\.vimeo\.com\/video\/|vimeo\.com\/(?:video\/)?)([0-9]{5,12})/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const vid = m[1];
        if (!seenIds.has(vid)) {
          seenIds.add(vid);
          found.push({ vimeoId: vid, src: '', title: '', configFound: false,
                       hasProgressiveFiles: false, hasHls: false, hasDash: false, strategy: 'html-regex' });
        }
      }
    } catch(_) {}

    // Estrategia C: configs capturadas por el interceptor del frame
    try {
      const injected = window.__vimeoInterceptedConfigs || {};
      for (const [vid, cfg] of Object.entries(injected)) {
        if (!seenIds.has(vid)) {
          seenIds.add(vid);
          found.push({
            vimeoId: vid,
            src: '',
            title: cfg?.video?.title || '',
            configFound: true,
            hasProgressiveFiles: !!(cfg?.request?.files?.progressive?.length),
            hasHls: !!(cfg?.request?.files?.hls),
            hasDash: !!(cfg?.request?.files?.dash),
            strategy: 'interceptor'
          });
        }
      }
    } catch(_) {}

    window.__VIMEO_EMBEDS__ = found;
    return found;
  };

  window.__getVimeoConfig = function (videoId) {
    // 1. Desde interceptor
    try {
      const injected = window.__vimeoInterceptedConfigs || {};
      if (injected[videoId]) return { config: injected[videoId], error: null, source: 'interceptor' };
    } catch(_) {}
    // 2. Desde playerConfig del iframe
    const collected = [];
    collectIframes(document, collected);
    for (const { el, val } of collected) {
      if (el.tagName !== 'IFRAME') continue;
      const vid = extractId(val);
      if (vid !== String(videoId)) continue;
      const cfg = getPlayerConfig(el);
      if (cfg) return { config: cfg, error: null, source: 'playerConfig' };
      return { config: null, error: 'iframe encontrado pero sin acceso al playerConfig (cross-origin o cargando)', source: null };
    }
    return { config: null, error: 'No se encontró iframe con ID ' + videoId, source: null };
  };

  // MutationObserver para iframes dinámicos
  try {
    new MutationObserver(() => {
      try { window.__scanVimeoEmbedsNow(); } catch(_) {}
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch(_) {}

  // Escaneo inicial + diferido
  try { window.__scanVimeoEmbedsNow(); } catch(_) {}
  setTimeout(() => { try { window.__scanVimeoEmbedsNow(); } catch(_) {} }, 1500);
  setTimeout(() => { try { window.__scanVimeoEmbedsNow(); } catch(_) {} }, 4000);
})();
