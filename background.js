/* background.js - Service Worker MV3 v6.3
 * Descarga HLS/DASH via helper nativo (yt-dlp o ffmpeg) o via m3u8 directo
 */

function safeFilename(name) {
  return (name || 'video-vimeo')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function normalizeHost(v) {
  return (v || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

function hostAllowed(pageUrl, allowedHost) {
  try {
    var h = new URL(pageUrl).hostname.toLowerCase();
    var a = normalizeHost(allowedHost);
    return a && (h === a || h.endsWith('.' + a));
  } catch (_) { return false; }
}

async function runInPage(tabId, fn, args) {
  var results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: fn,
    args: args || []
  });
  return results && results[0] && results[0].result;
}

async function getEmbeds(tabId) {
  return await runInPage(tabId, function () {
    if (typeof window.__scanVimeoEmbedsNow === 'function') return window.__scanVimeoEmbedsNow();
    return window.__VIMEO_EMBEDS__ || [];
  });
}

async function getConfig(tabId, videoId) {
  return await runInPage(tabId, async function (vid) {
    if (typeof window.__getVimeoConfig === 'function') return await window.__getVimeoConfig(vid);
    return { config: null, error: 'page_scanner.js no cargado. Recarga la pagina.' };
  }, [videoId]);
}

function parseCandidates(config) {
  var out = [];
  var prog = (config.request && config.request.files && config.request.files.progressive)
    || (config.files && config.files.progressive) || [];
  if (Array.isArray(prog)) prog.forEach(function (f) {
    if (f && f.url) out.push({ source: 'progressive', quality: String(f.quality || f.height || 'sd'), height: Number(f.height || 0), mime: f.mime || 'video/mp4', url: f.url, size: f.size || null });
  });

  var dl = config.download || (config.request && config.request.files && config.request.files.download) || [];
  if (Array.isArray(dl)) dl.forEach(function (f) {
    if (f && (f.link || f.url)) out.push({ source: 'download', quality: String(f.quality || f.height || 'sd'), height: Number(f.height || 0), mime: f.type || 'video/mp4', url: f.link || f.url, size: f.size || null });
  });

  var files = (config.request && config.request.files) || config.files || {};
  if (files.hls && files.hls.cdns) Object.values(files.hls.cdns).forEach(function (c) {
    if (c && c.url) out.push({ source: 'hls', quality: 'hls', height: 0, mime: 'application/x-mpegURL', url: c.url });
  });
  if (files.dash && files.dash.cdns) Object.values(files.dash.cdns).forEach(function (c) {
    if (c && c.url) out.push({ source: 'dash', quality: 'dash', height: 0, mime: 'application/dash+xml', url: c.url });
  });

  function deepFindMp4(obj, depth) {
    if (!obj || depth > 6) return;
    if (typeof obj === 'string') { if (/\.mp4/i.test(obj) && /^https?:\/\//.test(obj)) out.push({ source: 'deep', quality: 'unknown', height: 0, mime: 'video/mp4', url: obj }); return; }
    if (Array.isArray(obj)) { obj.forEach(function (i) { deepFindMp4(i, depth + 1); }); return; }
    if (typeof obj === 'object') Object.values(obj).forEach(function (v) { deepFindMp4(v, depth + 1); });
  }
  deepFindMp4(config, 0);

  var seen = {};
  return out.filter(function (c) { if (!c.url || seen[c.url]) return false; seen[c.url] = true; return true; });
}

function pickBestDirect(candidates) {
  var direct = candidates.filter(function (c) { return /progressive|download|deep/.test(c.source); });
  return direct.sort(function (a, b) { return (b.height || 0) - (a.height || 0); })[0] || null;
}

function pickBestHls(candidates) {
  return candidates.find(function (c) { return c.source === 'hls'; }) || null;
}

async function getActiveTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

/* ========== HANDLER PRINCIPAL ========== */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    var type    = msg && msg.type;
    var payload = msg && msg.payload;

    /* GET_EMBEDS */
    if (type === 'GET_EMBEDS') {
      var tab = await getActiveTab();
      if (!tab) return sendResponse({ ok: false, message: 'No se encontro la pestana activa.' });
      var embeds = await getEmbeds(tab.id);
      return sendResponse({ ok: true, embeds: embeds || [], tabId: tab.id, pageUrl: tab.url });
    }

    /* GET_RAW_CONFIG */
    if (type === 'GET_RAW_CONFIG') {
      var r0 = await getConfig(payload.tabId, payload.vimeoId);
      if (!r0 || !r0.config) return sendResponse({ ok: false, message: (r0 && r0.error) || 'Sin config.' });
      var cfg0 = r0.config;
      var cands0 = parseCandidates(cfg0);
      return sendResponse({
        ok: true,
        rawKeys: Object.keys(cfg0),
        requestKeys: cfg0.request ? Object.keys(cfg0.request) : [],
        filesKeys: (cfg0.request && cfg0.request.files) ? Object.keys(cfg0.request.files) : (cfg0.files ? Object.keys(cfg0.files) : []),
        candidates: cands0,
        videoTitle: (cfg0.video && cfg0.video.title) || ''
      });
    }

    /* TRY_DOWNLOAD / DIAGNOSE_VIDEO */
    if (type === 'TRY_DOWNLOAD' || type === 'DIAGNOSE_VIDEO') {
      var settings = await chrome.storage.local.get(['allowedHost']);
      if (!settings.allowedHost) return sendResponse({ ok: false, message: 'Primero guarda el dominio permitido.' });
      if (!hostAllowed(payload.pageUrl, settings.allowedHost)) return sendResponse({ ok: false, message: 'Dominio no permitido.' });
      if (!payload.vimeoId) return sendResponse({ ok: false, message: 'Sin Vimeo ID.' });

      var result = await getConfig(payload.tabId, payload.vimeoId);
      if (!result || !result.config) return sendResponse({ ok: false, message: '\u274c ' + ((result && result.error) || 'Sin playerConfig.') });

      var cfg = result.config;
      var candidates = parseCandidates(cfg);
      var direct = pickBestDirect(candidates);
      var hls    = pickBestHls(candidates);
      var videoTitle = (cfg.video && cfg.video.title) || ('video-' + payload.vimeoId);
      var title = safeFilename(payload.preferredName || videoTitle);

      if (type === 'DIAGNOSE_VIDEO') {
        var msg2 = '\u2705 "' + videoTitle + '" | MP4 directo: ' + (direct ? direct.source + ' ' + direct.quality : 'NO') + ' | HLS: ' + (hls ? hls.url.slice(0, 70) + '...' : 'NO');
        return sendResponse({ ok: true, message: msg2 });
      }

      /* --- INTENTAR MP4 DIRECTO primero --- */
      if (direct && direct.url) {
        try {
          await chrome.downloads.download({ url: direct.url, filename: title + '.mp4', saveAs: true, conflictAction: 'uniquify' });
          return sendResponse({ ok: true, message: '\u2705 Descarga MP4 iniciada | ' + direct.source + ' ' + direct.quality });
        } catch (e) {
          return sendResponse({ ok: false, message: 'Error MP4: ' + e.message });
        }
      }

      /* --- FALLBACK: Descargar via HLS usando Native Messaging helper --- */
      if (hls && hls.url) {
        /* Intentar via helper nativo (requiere instalar vimeo_helper) */
        var helperResult = await tryNativeHelper(hls.url, title, cfg.video);
        if (helperResult.ok) return sendResponse(helperResult);

        /* Si no hay helper: ofrecer el m3u8 con instrucciones */
        return sendResponse({
          ok: false,
          hlsUrl: hls.url,
          videoTitle: videoTitle,
          needsHelper: true,
          message: '\u26a0\ufe0f Video HLS. URL copiada al log. Usa yt-dlp para descargarlo (instrucciones en el popup).'
        });
      }

      return sendResponse({ ok: false, message: '\u274c Sin archivos descargables.' });
    }

    /* COPY_HLS_URL */
    if (type === 'COPY_HLS_URL') {
      /* Guarda la URL HLS en storage para que el popup la muestre */
      await chrome.storage.local.set({ lastHlsUrl: payload.url, lastHlsTitle: payload.title });
      return sendResponse({ ok: true });
    }
  })();
  return true;
});

/* Intentar Native Messaging con helper externo */
async function tryNativeHelper(hlsUrl, title, videoMeta) {
  return new Promise(function (resolve) {
    try {
      var port = chrome.runtime.connectNative('com.sdaeducation.vimeohelper');
      var timeout = setTimeout(function () {
        try { port.disconnect(); } catch (_) {}
        resolve({ ok: false, message: 'Helper no disponible.' });
      }, 4000);
      port.onMessage.addListener(function (response) {
        clearTimeout(timeout);
        port.disconnect();
        if (response && response.ok) {
          resolve({ ok: true, message: '\u2705 Descarga iniciada via helper: ' + (response.file || title + '.mp4') });
        } else {
          resolve({ ok: false, message: 'Helper error: ' + (response && response.error || 'desconocido') });
        }
      });
      port.onDisconnect.addListener(function () {
        clearTimeout(timeout);
        resolve({ ok: false, message: 'Helper no instalado.' });
      });
      port.postMessage({ action: 'download', url: hlsUrl, title: title, meta: videoMeta || {} });
    } catch (e) {
      resolve({ ok: false, message: 'Native messaging no disponible: ' + e.message });
    }
  });
}
