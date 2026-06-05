/* page_scanner.js
 * world: MAIN | run_at: document_idle | matches: https://* http://*
 *
 * Corre en la pagina principal (NO en iframes).
 * 1. Escanea TODOS los embeds de Vimeo (iframes, data-attrs, JSON-LD, scripts inline)
 * 2. Recibe playerConfig de vimeo_interceptor.js via postMessage
 * 3. Expone window.__getVimeoConfig(videoId) para background.js
 */

/* ======= STORE ======= */
window.__vimeoConfigs = window.__vimeoConfigs || {};
window.__VIMEO_EMBEDS__ = window.__VIMEO_EMBEDS__ || [];

/* ======= RECIBIR CONFIG DESDE IFRAME ======= */
window.addEventListener('message', function (evt) {
  if (!evt.data || evt.data.__vimeoExt !== 'CONFIG') return;
  var videoId = String(evt.data.videoId || '');
  var config  = evt.data.config || null;
  if (videoId && config) {
    window.__vimeoConfigs[videoId] = { config: config, ts: Date.now() };
  }
});

/* ======= PEDIR CONFIG A IFRAMES ======= */
function requestFromIframes() {
  var iframes = document.querySelectorAll('iframe');
  for (var i = 0; i < iframes.length; i++) {
    var src = iframes[i].getAttribute('src') || iframes[i].getAttribute('data-src') || '';
    if (/vimeo\.com/.test(src)) {
      try { iframes[i].contentWindow.postMessage({ __vimeoExt: 'REQUEST_CONFIG' }, '*'); } catch (_) {}
    }
  }
}
window.__requestVimeoConfigs = requestFromIframes;

/* ======= ESPERAR CONFIG (hasta 6 segundos) ======= */
window.__getVimeoConfig = function (videoId) {
  return new Promise(function (resolve) {
    var id = String(videoId);
    if (window.__vimeoConfigs[id] && window.__vimeoConfigs[id].config) {
      return resolve(window.__vimeoConfigs[id]);
    }
    requestFromIframes();
    var elapsed = 0;
    var timer = setInterval(function () {
      elapsed += 300;
      if (window.__vimeoConfigs[id] && window.__vimeoConfigs[id].config) {
        clearInterval(timer);
        resolve(window.__vimeoConfigs[id]);
      } else if (elapsed >= 6000) {
        clearInterval(timer);
        resolve({ config: null, error: 'El iframe de Vimeo no entrego playerConfig en 6s. Verifica que el video este visible y cargado en la pagina.' });
      }
    }, 300);
  });
};

/* ======= SCANNER DE EMBEDS ======= */
function extractVimeoId(url) {
  if (!url) return null;
  var pp = [
    /player\.vimeo\.com\/video\/(\d+)/,
    /vimeo\.com\/video\/(\d+)/,
    /(?:^|[^\d])(\d{7,12})(?:[^\d]|$)/
  ];
  for (var i = 0; i < pp.length; i++) {
    var m = String(url).match(pp[i]);
    if (m) return m[1];
  }
  return null;
}

function titleNear(el) {
  var tries = ['title','aria-label','data-title','data-video-title','alt'];
  for (var i = 0; i < tries.length; i++) {
    var v = el.getAttribute && el.getAttribute(tries[i]);
    if (v && v.trim()) return v.trim();
  }
  var wrap = el.closest && el.closest('figure,.video,.video-wrap,.embed,.player-wrap,article,section');
  if (wrap) {
    var h = wrap.querySelector('h1,h2,h3,h4,h5,.title,.video-title');
    if (h && h.textContent && h.textContent.trim()) return h.textContent.trim();
  }
  return '';
}

function scanEmbeds() {
  var found = {};

  // 1. iframes
  document.querySelectorAll('iframe').forEach(function (f) {
    var src = f.getAttribute('src') || f.getAttribute('data-src') || '';
    if (!/vimeo\.com/.test(src)) return;
    try { src = new URL(src, location.href).href; } catch (_) {}
    var id = extractVimeoId(src);
    if (!id) return;
    found[id] = found[id] || { vimeoId: id, src: src, titleHint: titleNear(f), detectedBy: 'iframe', pageUrl: location.href };
  });

  // 2. data-vimeo-id / data-video-id
  document.querySelectorAll('[data-vimeo-id],[data-video-id],[data-vimeo-url]').forEach(function (el) {
    var id = el.getAttribute('data-vimeo-id') || el.getAttribute('data-video-id');
    var url = el.getAttribute('data-vimeo-url') || '';
    if (!id && url) id = extractVimeoId(url);
    if (!id) return;
    found[id] = found[id] || { vimeoId: id, src: url || ('https://player.vimeo.com/video/' + id), titleHint: titleNear(el), detectedBy: 'data-attr', pageUrl: location.href };
  });

  // 3. divs/sections con clase que suena a video player
  document.querySelectorAll('[class*="vimeo"],[class*="video-player"],[class*="embed-video"],[id*="vimeo"],[id*="video-player"]').forEach(function (el) {
    // buscar ID en atributos o contenido
    var raw = el.getAttribute('data-id') || el.getAttribute('data-video') || el.innerHTML || '';
    var id = extractVimeoId(raw);
    if (!id) return;
    found[id] = found[id] || { vimeoId: id, src: 'https://player.vimeo.com/video/' + id, titleHint: titleNear(el), detectedBy: 'class-hint', pageUrl: location.href };
  });

  // 4. JSON-LD
  document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
    var txt = s.textContent || '';
    var matches = txt.match(/vimeo\.com\/(?:video\/)?(\d{7,12})/g) || [];
    matches.forEach(function (m) {
      var id = (m.match(/(\d{7,12})/) || [])[1];
      if (id) found[id] = found[id] || { vimeoId: id, src: 'https://player.vimeo.com/video/' + id, titleHint: '', detectedBy: 'json-ld', pageUrl: location.href };
    });
  });

  // 5. Todos los scripts inline y page source
  document.querySelectorAll('script:not([src])').forEach(function (s) {
    var txt = s.textContent || '';
    var matches = txt.match(/(?:vimeo\.com\/(?:video\/)?|video_id["\s:=]+)(\d{7,12})/g) || [];
    matches.forEach(function (m) {
      var id = (m.match(/(\d{7,12})/) || [])[1];
      if (id) found[id] = found[id] || { vimeoId: id, src: 'https://player.vimeo.com/video/' + id, titleHint: '', detectedBy: 'inline-script', pageUrl: location.href };
    });
  });

  // 6. HTML completo de la pagina (ultima red de seguridad)
  var allHtml = document.documentElement.innerHTML || '';
  var htmlMatches = allHtml.match(/player\.vimeo\.com\/video\/(\d{7,12})/g) || [];
  htmlMatches.forEach(function (m) {
    var id = (m.match(/(\d{7,12})/) || [])[1];
    if (id) found[id] = found[id] || { vimeoId: id, src: 'https://player.vimeo.com/video/' + id, titleHint: '', detectedBy: 'html-scan', pageUrl: location.href };
  });

  var arr = Object.values(found);
  window.__VIMEO_EMBEDS__ = arr;
  return arr;
}

window.__scanVimeoEmbedsNow = scanEmbeds;

// Escanear al cargar
scanEmbeds();

// Reescanear cuando cambia el DOM (SPAs, lazy-load)
var _scanTimer = null;
new MutationObserver(function () {
  clearTimeout(_scanTimer);
  _scanTimer = setTimeout(scanEmbeds, 400);
}).observe(document.documentElement, { childList: true, subtree: true });

// Solicitar configs al cargar
if (document.readyState === 'complete') {
  requestFromIframes();
} else {
  window.addEventListener('load', requestFromIframes);
}
