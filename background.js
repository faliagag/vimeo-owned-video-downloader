/* background.js - Service Worker MV3 v6.4
 * Orquesta: deteccion, descarga MP4 directa, conversion HLS via offscreen
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
    target: { tabId: tabId }, world: 'MAIN', func: fn, args: args || []
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
    return { config: null, error: 'page_scanner.js no cargado.' };
  }, [videoId]);
}

function parseCandidates(config) {
  var out = [];
  var prog = (config.request && config.request.files && config.request.files.progressive) || (config.files && config.files.progressive) || [];
  if (Array.isArray(prog)) prog.forEach(function (f) {
    if (f && f.url) out.push({ source: 'progressive', quality: String(f.quality || f.height || 'sd'), height: Number(f.height || 0), mime: 'video/mp4', url: f.url, size: f.size || null });
  });
  var dl = config.download || (config.request && config.request.files && config.request.files.download) || [];
  if (Array.isArray(dl)) dl.forEach(function (f) {
    if (f && (f.link || f.url)) out.push({ source: 'download', quality: String(f.quality || f.height || 'sd'), height: Number(f.height || 0), mime: 'video/mp4', url: f.link || f.url, size: f.size || null });
  });
  var files = (config.request && config.request.files) || config.files || {};
  if (files.hls && files.hls.cdns) Object.values(files.hls.cdns).forEach(function (c) {
    if (c && c.url) out.push({ source: 'hls', quality: 'hls', height: 0, mime: 'application/x-mpegURL', url: c.url });
  });
  if (files.dash && files.dash.cdns) Object.values(files.dash.cdns).forEach(function (c) {
    if (c && c.url) out.push({ source: 'dash', quality: 'dash', height: 0, mime: 'application/dash+xml', url: c.url });
  });
  function deepMp4(obj, d) {
    if (!obj || d > 6) return;
    if (typeof obj === 'string') { if (/\.mp4/i.test(obj) && /^https?:\/\//.test(obj)) out.push({ source: 'deep', quality: 'unknown', height: 0, mime: 'video/mp4', url: obj }); return; }
    if (Array.isArray(obj)) { obj.forEach(function(i){ deepMp4(i, d+1); }); return; }
    if (typeof obj === 'object') Object.values(obj).forEach(function(v){ deepMp4(v, d+1); });
  }
  deepMp4(config, 0);
  var seen = {};
  return out.filter(function(c){ if(!c.url||seen[c.url]) return false; seen[c.url]=true; return true; });
}

function pickBestDirect(candidates) {
  var d = candidates.filter(function(c){ return /progressive|download|deep/.test(c.source); });
  return d.sort(function(a,b){ return (b.height||0)-(a.height||0); })[0] || null;
}
function pickBestHls(candidates) {
  return candidates.find(function(c){ return c.source === 'hls'; }) || null;
}

async function getActiveTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

/* Crear o reutilizar el Offscreen Document */
async function ensureOffscreen() {
  var existing = await chrome.offscreen.hasDocument().catch(function(){ return false; });
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_SCRAPING'],
      justification: 'Convertir HLS a MP4 usando ffmpeg.wasm'
    });
  }
}

/* Reenviar progreso al popup */
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg && msg.type === 'CONVERT_PROGRESS') {
    /* Broadcast al popup si esta abierto */
    chrome.runtime.sendMessage({ type: 'CONVERT_PROGRESS', message: msg.message }).catch(function(){});
    return;
  }

  (async function () {
    var type    = msg && msg.type;
    var payload = msg && msg.payload;

    if (type === 'GET_EMBEDS') {
      var tab = await getActiveTab();
      if (!tab) return sendResponse({ ok: false, message: 'No se encontro la pestana activa.' });
      var embeds = await getEmbeds(tab.id);
      return sendResponse({ ok: true, embeds: embeds || [], tabId: tab.id, pageUrl: tab.url });
    }

    if (type === 'GET_RAW_CONFIG') {
      var r0 = await getConfig(payload.tabId, payload.vimeoId);
      if (!r0 || !r0.config) return sendResponse({ ok: false, message: (r0 && r0.error) || 'Sin config.' });
      var cfg0 = r0.config; var cands0 = parseCandidates(cfg0);
      return sendResponse({ ok: true, rawKeys: Object.keys(cfg0), requestKeys: cfg0.request ? Object.keys(cfg0.request) : [], filesKeys: (cfg0.request&&cfg0.request.files)?Object.keys(cfg0.request.files):(cfg0.files?Object.keys(cfg0.files):[]), candidates: cands0, videoTitle: (cfg0.video&&cfg0.video.title)||'' });
    }

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
      var title  = safeFilename(payload.preferredName || videoTitle);

      if (type === 'DIAGNOSE_VIDEO') {
        var dm = '\u2705 "' + videoTitle + '" | MP4: ' + (direct ? direct.source : 'NO') + ' | HLS: ' + (hls ? 'SI' : 'NO');
        return sendResponse({ ok: true, message: dm });
      }

      /* MP4 directo */
      if (direct && direct.url) {
        try {
          await chrome.downloads.download({ url: direct.url, filename: title + '.mp4', saveAs: false, conflictAction: 'uniquify' });
          return sendResponse({ ok: true, message: '\u2705 Descarga MP4 iniciada.' });
        } catch (e) {
          return sendResponse({ ok: false, message: 'Error MP4: ' + e.message });
        }
      }

      /* HLS -> convertir en offscreen */
      if (hls && hls.url) {
        return sendResponse({ ok: true, converting: true, hlsUrl: hls.url, title: title, pageUrl: payload.pageUrl, message: '\u23f3 Iniciando conversion HLS\u2192MP4 en el navegador...' });
      }

      return sendResponse({ ok: false, message: '\u274c Sin archivos descargables.' });
    }

    /* CONVERT_HLS - llamado desde el popup cuando el usuario confirma */
    if (type === 'CONVERT_HLS') {
      try {
        await ensureOffscreen();
        /* Reenviar al offscreen document */
        var convResult = await chrome.runtime.sendMessage({ type: 'CONVERT_HLS', payload: payload });
        return sendResponse(convResult || { ok: false, message: 'Sin respuesta del conversor.' });
      } catch (e) {
        return sendResponse({ ok: false, message: 'Error offscreen: ' + e.message });
      }
    }
  })();
  return true;
});
