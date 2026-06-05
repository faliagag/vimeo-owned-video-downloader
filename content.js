/* content.js - corre en world:MAIN (ver manifest.json)
 * Al correr en MAIN tiene acceso real a window de la página
 * y puede recibir postMessage de vimeo_frame.js
 */

/* ---- STORE de configs recibidas desde los iframes de Vimeo ---- */
if (!window.__vimeoConfigs) window.__vimeoConfigs = {};

/* ---- Recibir playerConfig desde vimeo_frame.js ---- */
window.addEventListener('message', function (evt) {
  if (!evt.data || !evt.data.__vimeoExtFrameConfig) return;
  const { videoId, config, error } = evt.data;
  if (videoId) {
    window.__vimeoConfigs[videoId] = { config: config || null, error: error || null, ts: Date.now() };
  }
});

/* ---- Pedir config a todos los iframes de Vimeo ---- */
function requestConfigsFromIframes() {
  document.querySelectorAll('iframe[src*="vimeo.com"], iframe[data-src*="vimeo.com"]').forEach(function (f) {
    try { f.contentWindow.postMessage({ __vimeoExtCmd: 'REQUEST_CONFIG' }, '*'); } catch (_) {}
  });
}
window.__requestVimeoConfigs = requestConfigsFromIframes;

/* ---- Obtener config esperando respuesta hasta 5 segundos ---- */
window.__getVimeoConfig = function (videoId) {
  return new Promise(function (resolve) {
    // Ya tenemos el config
    if (window.__vimeoConfigs[videoId] && window.__vimeoConfigs[videoId].config) {
      return resolve(window.__vimeoConfigs[videoId]);
    }
    // Pedir a los iframes
    requestConfigsFromIframes();
    var start = Date.now();
    var poll = setInterval(function () {
      if (window.__vimeoConfigs[videoId] && window.__vimeoConfigs[videoId].config) {
        clearInterval(poll);
        resolve(window.__vimeoConfigs[videoId]);
      } else if (Date.now() - start > 5000) {
        clearInterval(poll);
        resolve({ config: null, error: 'Tiempo agotado esperando respuesta del iframe de Vimeo.' });
      }
    }, 200);
  });
};

/* ---- Detectar embeds de Vimeo en la pagina ---- */
function normalizeUrl(url) {
  try { return new URL(url, location.href).href; } catch (_) { return url || ''; }
}
function extractVimeoId(url) {
  if (!url) return null;
  var patterns = [
    /player\.vimeo\.com\/video\/(\d+)/,
    /vimeo\.com\/video\/(\d+)/,
    /vimeo\.com\/(\d+)/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = url.match(patterns[i]);
    if (m) return m[1];
  }
  return null;
}
function textAround(el) {
  var options = [];
  ['title','aria-label','data-title','data-video-title'].forEach(function(a) {
    var v = el.getAttribute && el.getAttribute(a);
    if (v) options.push(v.trim());
  });
  var wrap = el.closest && el.closest('figure,.video,.video-item,.embed,.player,article,section,div');
  var h = wrap && wrap.querySelector && wrap.querySelector('h1,h2,h3,h4,strong,b');
  if (h && h.textContent) options.push(h.textContent.trim());
  return options.find(Boolean) || '';
}
function fromIframes() {
  return Array.from(document.querySelectorAll('iframe')).map(function(f) {
    var src = normalizeUrl(f.getAttribute('src') || f.getAttribute('data-src') || '');
    if (!/player\.vimeo\.com|vimeo\.com/.test(src)) return null;
    return { kind:'iframe', detectedBy:'iframe', src:src, vimeoId:extractVimeoId(src), titleHint:textAround(f) };
  }).filter(Boolean);
}
function fromAttrs() {
  return Array.from(document.querySelectorAll('a[href*="vimeo.com"],[data-vimeo-id],[data-video-id],[data-vimeo-url]')).map(function(el) {
    var raw = el.getAttribute('href') || el.getAttribute('data-vimeo-url') || '';
    var id = el.getAttribute('data-vimeo-id') || el.getAttribute('data-video-id') || extractVimeoId(raw);
    if (!raw && !id) return null;
    return { kind:'attr', detectedBy:'link/data-attr', src:normalizeUrl(raw||('https://player.vimeo.com/video/'+id)), vimeoId:id, titleHint:textAround(el) };
  }).filter(function(v){ return v && (v.vimeoId || /vimeo\.com/.test(v.src)); });
}
function unique(items) {
  var map = {};
  items.forEach(function(item) {
    var key = item.vimeoId || item.src;
    if (key && !map[key]) map[key] = Object.assign({}, item, { pageUrl: location.href });
  });
  return Object.values(map);
}
function scanVimeoEmbedsNow() {
  var found = unique(fromIframes().concat(fromAttrs()));
  window.__VIMEO_EMBEDS__ = found;
  return found;
}
window.__scanVimeoEmbedsNow = scanVimeoEmbedsNow;
scanVimeoEmbedsNow();

new MutationObserver(function() { scanVimeoEmbedsNow(); }).observe(document.documentElement, {
  childList: true, subtree: true, attributes: true,
  attributeFilter: ['src','href','data-src','data-vimeo-id','data-video-id','data-vimeo-url']
});

// Solicitar configs al cargar la pagina
if (document.readyState === 'complete') {
  requestConfigsFromIframes();
} else {
  window.addEventListener('load', requestConfigsFromIframes);
}
