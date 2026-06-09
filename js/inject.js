// inject.js - Contexto de la página (acceso a window, XHR, fetch)
(function () {
  'use strict';

  if (window.__vimeoInjected) {
    window.__vimeoRescan && window.__vimeoRescan();
    return;
  }
  window.__vimeoInjected = true;

  const PATTERNS = [
    /player\.vimeo\.com\/video/,
    /vimeocdn\.com/,
    /api\.vimeo\.com/,
    /fresnel\.vimeocdn/,
    /vimeo\.com\/api/
  ];

  function isVimeoUrl(url) {
    return url && PATTERNS.some(p => p.test(url));
  }

  function dispatch(videos, title) {
    if (!videos || videos.length === 0) return;
    window.postMessage({ type: 'VIMEO_VIDEOS_FOUND', videos, title: title || document.title }, '*');
  }

  // ── Interceptar XHR ──────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._vimeoUrl = String(url || '');
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        if (!isVimeoUrl(this._vimeoUrl)) return;
        processConfig(JSON.parse(this.responseText));
      } catch (e) {}
    });
    return _send.apply(this, arguments);
  };

  // ── Interceptar fetch ────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    const p = _fetch.apply(this, arguments);
    if (isVimeoUrl(url)) {
      p.then(res => res.clone().json().then(processConfig).catch(() => {})).catch(() => {});
    }
    return p;
  };

  // ── Procesar configuración Vimeo ──────────────────────────────────────────
  function processConfig(data) {
    if (!data || typeof data !== 'object') return;

    let files = null;
    let title = '';

    if (data.request?.files) {
      files = data.request.files;
      title = data.video?.title || data.clip?.title || '';
    } else if (data.config?.request?.files) {
      files = data.config.request.files;
      title = data.config?.video?.title || '';
    } else if (data.progressive || data.hls || data.dash) {
      files = data;
      title = data.title || '';
    } else if (Array.isArray(data) && data[0]?.link) {
      const videos = data.filter(v => v.link).map(v => ({
        quality: v.quality || (v.height ? v.height + 'p' : '?'),
        url: v.link, width: v.width || 0, height: v.height || 0, type: 'mp4'
      }));
      if (videos.length) dispatch(videos, '');
      return;
    }

    if (!files) return;

    const videos = [];
    if (Array.isArray(files.progressive)) {
      files.progressive.forEach(v => {
        if (v.url) videos.push({
          quality: v.quality || (v.height ? v.height + 'p' : '?'),
          url: v.url, width: v.width || 0, height: v.height || 0, type: 'mp4'
        });
      });
    }
    if (files.hls?.cdns) {
      const cdn = Object.values(files.hls.cdns)[0];
      if (cdn?.url) videos.push({ quality: 'HLS', url: cdn.url, type: 'hls' });
    } else if (files.hls?.url) {
      videos.push({ quality: 'HLS', url: files.hls.url, type: 'hls' });
    }
    if (files.dash?.cdns) {
      const cdn = Object.values(files.dash.cdns)[0];
      if (cdn?.url) videos.push({ quality: 'DASH', url: cdn.url, type: 'dash' });
    } else if (files.dash?.url) {
      videos.push({ quality: 'DASH', url: files.dash.url, type: 'dash' });
    }

    if (videos.length) {
      videos.sort((a, b) => (b.height || 0) - (a.height || 0));
      dispatch(videos, title);
    }
  }

  // ── Escanear DOM y objetos globales ───────────────────────────────────────
  function scanDOM() {
    const candidates = [
      window?.vimeo, window?.playerConfig, window?.vimeo_config,
      window?.__INITIAL_STATE__, window?.__NEXT_DATA__,
    ];
    candidates.forEach(obj => {
      if (obj && typeof obj === 'object') {
        try { processConfig(obj); } catch (e) {}
        if (obj.props?.pageProps?.clip_page_data) {
          try { processConfig(obj.props.pageProps.clip_page_data); } catch (e) {}
        }
      }
    });

    document.querySelectorAll('script:not([src])').forEach(s => {
      const t = s.textContent;
      if (!t || t.length < 100) return;
      const patterns = [
        /window\.__INITIAL_STATE__\s*=\s*(\{.+\})/s,
        /var\s+config\s*=\s*(\{.+?\})\s*;/s,
        /playerConfig\s*=\s*(\{.+?\})/s,
        /"config":\s*(\{[\s\S]+?"request":[\s\S]+?\})/,
        /JSON\.parse\('([^']+)'\)/
      ];
      patterns.forEach(re => {
        const m = t.match(re);
        if (!m) return;
        try {
          const raw = m[1].startsWith('{') ? m[1] : JSON.parse('"' + m[1] + '"');
          processConfig(typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(m[1]));
        } catch (e) {}
      });
    });

    document.querySelectorAll('video').forEach(v => {
      const src = v.src || v.currentSrc;
      if (src && isVimeoUrl(src)) {
        window.postMessage({ type: 'VIMEO_VIDEOS_FOUND', videos: [{ quality: 'Detectado', url: src, type: 'mp4', height: 0 }], title: document.title }, '*');
      }
    });
  }

  window.__vimeoRescan = scanDOM;

  let scanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanDOM, 300);
  });

  function startObserver() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    scanDOM();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }

  // Rescans diferidos para players que cargan tarde
  [1000, 3000, 6000].forEach(t => setTimeout(scanDOM, t));

})();
