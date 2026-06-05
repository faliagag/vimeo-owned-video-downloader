/* background.js - Service Worker MV3 v6.2
 * Diagnostico muestra config RAW para identificar donde estan los archivos
 */

function safeFilename(name) {
  return (name || 'video-vimeo')
    .replace(/[\/\\:*?"<>|]+/g, '-')
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
    if (typeof window.__getVimeoConfig === 'function') {
      return await window.__getVimeoConfig(vid);
    }
    return { config: null, error: 'page_scanner.js no cargado. Recarga la pagina.' };
  }, [videoId]);
}

/* Busca archivos descargables en CUALQUIER lugar del config */
function parseCandidates(config) {
  var out = [];

  /* 1. progressive clasico */
  var prog = (config.request && config.request.files && config.request.files.progressive)
    || (config.files && config.files.progressive) || [];
  if (Array.isArray(prog)) {
    prog.forEach(function (f) {
      if (f && f.url) out.push({
        source: 'progressive', quality: String(f.quality || f.rendition || f.height || 'sd'),
        height: Number(f.height || 0), mime: f.mime || f.type || 'video/mp4',
        url: f.url, size: f.size || null
      });
    });
  }

  /* 2. download array (plan Pro/Business) */
  var dl = config.download || (config.request && config.request.files && config.request.files.download) || [];
  if (Array.isArray(dl)) {
    dl.forEach(function (f) {
      if (f && (f.link || f.url)) out.push({
        source: 'download', quality: String(f.quality || f.rendition || f.height || 'sd'),
        height: Number(f.height || 0), mime: f.type || 'video/mp4',
        url: f.link || f.url, size: f.size || null
      });
    });
  }

  /* 3. source_files (algunos planes) */
  var sf = config.source_files || (config.request && config.request.source_files) || [];
  if (Array.isArray(sf)) {
    sf.forEach(function (f) {
      if (f && (f.url || f.link)) out.push({
        source: 'source_file', quality: String(f.quality || f.rendition || f.height || 'original'),
        height: Number(f.height || 0), mime: f.type || 'video/mp4',
        url: f.url || f.link, size: f.size || null
      });
    });
  }

  /* 4. HLS/DASH manifests como fallback */
  var files = (config.request && config.request.files) || config.files || {};
  if (files.hls && files.hls.cdns) {
    Object.values(files.hls.cdns).forEach(function (c) {
      if (c && c.url) out.push({ source: 'hls', quality: 'stream-hls', height: 0, mime: 'application/x-mpegURL', url: c.url });
    });
  }
  if (files.dash && files.dash.cdns) {
    Object.values(files.dash.cdns).forEach(function (c) {
      if (c && c.url) out.push({ source: 'dash', quality: 'stream-dash', height: 0, mime: 'application/dash+xml', url: c.url });
    });
  }

  /* 5. Busqueda generica: recorrer todo el config buscando URLs .mp4 */
  function deepFindMp4(obj, depth) {
    if (!obj || depth > 6) return;
    if (typeof obj === 'string') {
      if (/\.mp4/i.test(obj) && /^https?:\/\//.test(obj)) {
        out.push({ source: 'deep-scan', quality: 'unknown', height: 0, mime: 'video/mp4', url: obj, size: null });
      }
      return;
    }
    if (Array.isArray(obj)) { obj.forEach(function (i) { deepFindMp4(i, depth + 1); }); return; }
    if (typeof obj === 'object') { Object.values(obj).forEach(function (v) { deepFindMp4(v, depth + 1); }); }
  }
  deepFindMp4(config, 0);

  /* Deduplicar por URL */
  var seen = {};
  return out.filter(function (c) {
    if (!c.url || seen[c.url]) return false;
    seen[c.url] = true;
    return true;
  });
}

function pickBest(candidates, preferred) {
  var direct = candidates.filter(function (c) { return /progressive|download|source_file|deep-scan/.test(c.source); });
  if (!direct.length) return null;
  if (!preferred || preferred === 'best') {
    return direct.sort(function (a, b) { return (b.height || 0) - (a.height || 0); })[0];
  }
  var target = Number(preferred);
  var exact = direct.filter(function (c) { return Number(c.height) === target; });
  if (exact.length) return exact.sort(function (a, b) { return (b.height || 0) - (a.height || 0); })[0];
  var lower = direct.filter(function (c) { return Number(c.height) <= target; });
  if (lower.length) return lower.sort(function (a, b) { return (b.height || 0) - (a.height || 0); })[0];
  return direct.sort(function (a, b) { return (a.height || 99999) - (b.height || 99999); })[0];
}

async function getActiveTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

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

    /* GET_RAW_CONFIG - para debug */
    if (type === 'GET_RAW_CONFIG') {
      var result0 = await getConfig(payload.tabId, payload.vimeoId);
      if (!result0 || !result0.config) {
        return sendResponse({ ok: false, message: (result0 && result0.error) || 'Sin config.' });
      }
      /* Devolver las claves del primer nivel y los candidatos encontrados */
      var cfg0 = result0.config;
      var cands0 = parseCandidates(cfg0);
      var keys0 = Object.keys(cfg0);
      var reqKeys = cfg0.request ? Object.keys(cfg0.request) : [];
      var filesKeys = (cfg0.request && cfg0.request.files) ? Object.keys(cfg0.request.files) : (cfg0.files ? Object.keys(cfg0.files) : []);
      return sendResponse({
        ok: true,
        rawKeys: keys0,
        requestKeys: reqKeys,
        filesKeys: filesKeys,
        candidates: cands0,
        videoTitle: (cfg0.video && cfg0.video.title) || ''
      });
    }

    /* TRY_DOWNLOAD / DIAGNOSE_VIDEO */
    if (type === 'TRY_DOWNLOAD' || type === 'DIAGNOSE_VIDEO') {
      var settings = await chrome.storage.local.get(['allowedHost']);
      if (!settings.allowedHost) {
        return sendResponse({ ok: false, message: 'Primero guarda el dominio permitido.' });
      }
      if (!hostAllowed(payload.pageUrl, settings.allowedHost)) {
        return sendResponse({ ok: false, message: 'Dominio no permitido: ' + settings.allowedHost });
      }
      if (!payload.vimeoId) return sendResponse({ ok: false, message: 'Sin Vimeo ID.' });

      var result = await getConfig(payload.tabId, payload.vimeoId);
      if (!result || !result.config) {
        return sendResponse({ ok: false, message: '\u274c ' + ((result && result.error) || 'Sin playerConfig.') });
      }

      var cfg = result.config;
      var candidates = parseCandidates(cfg);
      var direct  = candidates.filter(function (c) { return /progressive|download|source_file|deep-scan/.test(c.source); });
      var streams = candidates.filter(function (c) { return /hls|dash/.test(c.source); });
      var videoTitle = (cfg.video && cfg.video.title) || 'sin titulo';

      if (type === 'DIAGNOSE_VIDEO') {
        var quals = direct.map(function (d) { return '[' + d.source + '] ' + d.quality + (d.height ? 'p' : ''); }).join(' | ') || 'ninguna';
        var hlsUrl = streams.length ? streams[0].url.slice(0, 80) + '...' : 'no';
        var diagMsg = '\u2705 "' + videoTitle + '" | MP4: ' + direct.length + ' | Stream: ' + streams.length + ' | Calidades: ' + quals + ' | HLS: ' + hlsUrl;
        return sendResponse({ ok: true, message: diagMsg });
      }

      var chosen = pickBest(candidates, payload.preferredQuality);
      var title  = safeFilename(payload.preferredName || videoTitle || ('video-' + payload.vimeoId));

      if (chosen && chosen.url) {
        var ext = /webm/i.test(chosen.mime || '') ? 'webm' : 'mp4';
        try {
          await chrome.downloads.download({
            url: chosen.url, filename: title + '.' + ext,
            saveAs: true, conflictAction: 'uniquify'
          });
          var sz = chosen.size ? ' ~' + Math.round(chosen.size / 1024 / 1024) + ' MB' : '';
          return sendResponse({ ok: true, message: '\u2705 Descarga iniciada | ' + chosen.source + ' | ' + chosen.quality + (chosen.height ? 'p' : '') + sz });
        } catch (e) {
          return sendResponse({ ok: false, message: 'Error: ' + e.message });
        }
      }

      if (streams.length) {
        return sendResponse({ ok: false, message: '\u26a0\ufe0f Solo HLS/DASH. Vimeo no expone MP4 en este plan para descarga directa.' });
      }
      return sendResponse({ ok: false, message: '\u274c Sin archivos descargables.' });
    }
  })();
  return true;
});
