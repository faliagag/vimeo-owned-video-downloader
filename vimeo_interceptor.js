/* vimeo_interceptor.js
 * world: MAIN | run_at: document_start | matches: https://player.vimeo.com/*
 *
 * Se inyecta ANTES que Vimeo cargue cualquier script.
 * Parchea XHR y fetch del iframe para capturar el config JSON
 * que Vimeo descarga desde su propio dominio.
 * Envia el resultado al padre via postMessage.
 * CERO fetch externo. CERO CORS. CERO 403.
 */
(function () {
  if (!location.hostname.includes('vimeo.com')) return;

  var _videoId = (location.pathname.match(/\/video\/(\d+)/) || [])[1] || null;
  var _capturedConfig = null;

  function send(cfg) {
    if (_capturedConfig) return; // ya enviado
    _capturedConfig = cfg;
    try {
      window.parent.postMessage({
        __vimeoExt: 'CONFIG',
        videoId: _videoId,
        config: cfg
      }, '*');
    } catch (_) {}
    // retry por si el padre no estaba listo
    setTimeout(function () {
      try {
        window.parent.postMessage({
          __vimeoExt: 'CONFIG',
          videoId: _videoId,
          config: cfg
        }, '*');
      } catch (_) {}
    }, 800);
  }

  function tryParseConfig(text) {
    try {
      var obj = JSON.parse(text);
      // config valida tiene request.files o video
      if (obj && (obj.request || obj.video || obj.files || obj.download)) return obj;
    } catch (_) {}
    return null;
  }

  function isConfigUrl(url) {
    return /\/config|video_config|player_config/.test(url);
  }

  /* ---- Parchear fetch ---- */
  var _origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var p = _origFetch.apply(this, arguments);
    if (isConfigUrl(url)) {
      p.then(function (resp) {
        var clone = resp.clone();
        clone.text().then(function (txt) {
          var cfg = tryParseConfig(txt);
          if (cfg) send(cfg);
        }).catch(function () {});
      }).catch(function () {});
    }
    return p;
  };

  /* ---- Parchear XMLHttpRequest ---- */
  var _XHR = window.XMLHttpRequest;
  function PatchedXHR() {
    var xhr = new _XHR();
    var _url = '';
    var _origOpen = xhr.open.bind(xhr);
    var _origSend = xhr.send.bind(xhr);

    xhr.open = function (method, url) {
      _url = url || '';
      return _origOpen.apply(xhr, arguments);
    };
    xhr.send = function () {
      if (isConfigUrl(_url)) {
        xhr.addEventListener('load', function () {
          var cfg = tryParseConfig(xhr.responseText);
          if (cfg) send(cfg);
        });
      }
      return _origSend.apply(xhr, arguments);
    };
    return xhr;
  }
  PatchedXHR.prototype = _XHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  /* ---- Fallback: leer window.playerConfig una vez cargado ---- */
  function checkPlayerConfig() {
    if (_capturedConfig) return;
    var cfg = window.playerConfig || (window.vimeo && window.vimeo.clip_page_object);
    if (cfg && (cfg.request || cfg.video || cfg.files)) {
      send(cfg);
      return true;
    }
    // buscar en scripts inline
    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length; i++) {
      var txt = scripts[i].textContent || '';
      // buscar progressive directo
      var m = txt.match(/"progressive"\s*:\s*(\[\{[\s\S]{10,3000}?\}\])/);
      if (m) {
        try {
          var prog = JSON.parse(m[1]);
          send({ request: { files: { progressive: prog } }, video: { title: 'video-' + _videoId } });
          return true;
        } catch (_) {}
      }
      // buscar playerConfig inline
      var m2 = txt.match(/playerConfig\s*[=:]\s*(\{[\s\S]{20,})/);
      if (m2) {
        var depth = 0, start = m2[1].indexOf('{'), end = -1;
        var s = m2[1];
        for (var j = start; j < s.length; j++) {
          if (s[j] === '{') depth++;
          else if (s[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
        }
        if (end > start) {
          try {
            var parsed = JSON.parse(s.substring(start, end + 1));
            if (parsed && (parsed.request || parsed.video || parsed.files)) {
              send(parsed);
              return true;
            }
          } catch (_) {}
        }
      }
    }
    return false;
  }

  // Responder a solicitudes del padre
  window.addEventListener('message', function (evt) {
    if (evt.data && evt.data.__vimeoExt === 'REQUEST_CONFIG') {
      if (_capturedConfig) {
        send(_capturedConfig);
      } else {
        checkPlayerConfig();
      }
    }
  });

  // Verificar al cargar
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(checkPlayerConfig, 500);
    setTimeout(checkPlayerConfig, 1500);
    setTimeout(checkPlayerConfig, 3000);
  });
  window.addEventListener('load', function () {
    checkPlayerConfig();
    setTimeout(checkPlayerConfig, 1000);
  });
})();
