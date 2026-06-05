/* vimeo_frame.js
 * Corre en world:MAIN dentro del iframe de player.vimeo.com
 * Lee window.playerConfig (que Vimeo ya tiene disponible) y lo retransmite
 * al content.js de la página padre via postMessage.
 * NO hace ningún fetch externo → sin CORS, sin 403.
 */
(function () {
  if (!location.hostname.includes('vimeo.com')) return;

  function extractVideoId() {
    const m = location.pathname.match(/\/video\/(\d+)/);
    return m ? m[1] : null;
  }

  function extractProgressiveFromDOM() {
    // Vimeo a veces deja los archivos en un script tag como JSON
    const scripts = [...document.querySelectorAll('script:not([src])')];
    for (const s of scripts) {
      const txt = s.textContent || '';
      // Buscar el objeto completo playerConfig
      const cfgMatch = txt.match(/(?:window\.playerConfig|var\s+playerConfig)\s*=\s*(\{[\s\S]{50,})/);
      if (cfgMatch) {
        try {
          // Extraer JSON equilibrado
          let depth = 0, start = cfgMatch[1].indexOf('{'), end = -1;
          for (let i = start; i < cfgMatch[1].length; i++) {
            if (cfgMatch[1][i] === '{') depth++;
            else if (cfgMatch[1][i] === '}') { depth--; if (depth === 0) { end = i; break; } }
          }
          if (end > start) {
            return JSON.parse(cfgMatch[1].substring(start, end + 1));
          }
        } catch (_) {}
      }
      // Buscar array progressive directamente
      const progMatch = txt.match(/"progressive"\s*:\s*(\[\s*\{[\s\S]{20,5000}?\}\s*\])/);
      if (progMatch) {
        try { return { request: { files: { progressive: JSON.parse(progMatch[1]) } }, video: { title: 'video-' + extractVideoId() } }; } catch (_) {}
      }
    }
    return null;
  }

  function getConfig() {
    // 1. window.playerConfig (lo más directo)
    if (window.playerConfig && window.playerConfig.request) return window.playerConfig;
    // 2. window.vimeo.clip_page_object (plan Business+)
    if (window.vimeo && window.vimeo.clip_page_object) return window.vimeo.clip_page_object;
    // 3. Extraer desde DOM
    return extractProgressiveFromDOM();
  }

  function sendConfig() {
    const videoId = extractVideoId();
    if (!videoId) return;
    const cfg = getConfig();
    // Enviar al padre (la página de tu sitio)
    try {
      window.parent.postMessage({
        __vimeoExtFrameConfig: true,
        videoId,
        config: cfg || null,
        error: cfg ? null : 'playerConfig no disponible en este iframe'
      }, '*');
    } catch (_) {}
  }

  // Enviar cuando esté listo
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    sendConfig();
  } else {
    document.addEventListener('DOMContentLoaded', sendConfig);
  }

  // También escuchar si el popup pide el config bajo demanda
  window.addEventListener('message', function (evt) {
    if (evt.data && evt.data.__vimeoExtCmd === 'REQUEST_CONFIG') {
      sendConfig();
    }
  });

  // Observar cambios en caso de carga diferida
  let sent = false;
  const obs = new MutationObserver(() => {
    if (!sent && getConfig()) {
      sent = true;
      sendConfig();
      obs.disconnect();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
