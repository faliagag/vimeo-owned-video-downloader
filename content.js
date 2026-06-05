(function () {
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
      [...txt.matchAll(/vimeo\.com\/(?:video\/)?(\d+)/g)].forEach(m => out.push({ kind: 'jsonld', detectedBy: 'json-ld', src: `https://player.vimeo.com/video/${m[1]}`, vimeoId: m[1], titleHint: '' }));
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
  new MutationObserver(() => scanVimeoEmbedsNow()).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'data-src', 'data-vimeo-id', 'data-video-id', 'data-vimeo-url'] });
})();
