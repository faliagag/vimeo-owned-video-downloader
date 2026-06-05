/* background.js - Service Worker MV3
 * Recibe mensajes del popup y ejecuta acciones en el contexto de la pagina
 * usando scripting.executeScript(world:MAIN)
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

/* Ejecuta una funcion en world:MAIN de la pestana */
async function runInPage(tabId, fn, args) {
  var results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: fn,
    args: args || []
  });
  return results && results[0] && results[0].result;
}

/* Obtiene lista de embeds detectados */
async function getEmbeds(tabId) {
  return await runInPage(tabId, function () {
    if (typeof window.__scanVimeoEmbedsNow === 'function') return window.__scanVimeoEmbedsNow();
    return window.__VIMEO_EMBEDS__ || [];
  });
}

/* Obtiene config de un video via vimeo_interceptor -> page_scanner */
async function getConfig(tabId, videoId) {
  return await runInPage(tabId, async function (vid) {
    if (typeof window.__getVimeoConfig === 'function') {
      return await window.__getVimeoConfig(vid);
    }
    return { config: null, error: 'page_scanner.js no esta cargado. Recarga la pagina.' };
  }, [videoId]);
}

/* Parsear archivos del config */
function parseCandidates(config) {
  var out = [];
  var prog = (config.request && config.request.files && config.request.files.progressive)
    || config.progressive || config.files && config.files.progressive || [];
  if (Array.isArray(prog)) {
    prog.forEach(function (f) {
      if (f && f.url) out.push({
        source: 'progressive', quality: String(f.quality || f.rendition || f.height || 'sd'),
        height: Number(f.height || 0), mime: f.mime || f.type || 'video/mp4',
        url: f.url, size: f.size || null
      });
    });
  }
  var dl = config.download || [];
  if (Array.isArray(dl)) {
    dl.forEach(function (f) {
      if (f && (f.link || f.url)) out.push({
        source: 'download', quality: String(f.quality || f.rendition || f.height || 'sd'),
        height: Number(f.height || 0), mime: f.type || 'video/mp4',
        url: f.link || f.url, size: f.size || null
      });
    });
  }
  var files = (config.request && config.request.files) || {};
  if (files.hls && files.hls.cdns) Object.values(files.hls.cdns).forEach(function (c) {
    if (c && c.url) out.push({ source: 'hls', quality: 'stream', height: 0, mime: 'application/x-mpegURL', url: c.url });
  });
  if (files.dash && files.dash.cdns) Object.values(files.dash.cdns).forEach(function (c) {
    if (c && c.url) out.push({ source: 'dash', quality: 'stream', height: 0, mime: 'application/dash+xml', url: c.url });
  });
  return out;
}

function pickBest(candidates, preferred) {
  var direct = candidates.filter(function (c) { return /progressive|download/.test(c.source); });
  if (!direct.length) return null;
  if (!preferred || preferred === 'best') return direct.sort(function (a, b) { return (b.height || 0) - (a.height || 0); })[0];
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

/* ======= HANDLER PRINCIPAL ======= */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    var type = msg && msg.type;
    var payload = msg && msg.payload;

    if (type === 'GET_EMBEDS') {
      var tab = await getActiveTab();
      if (!tab) return sendResponse({ ok: false, message: 'No se encontro la pestana activa.' });
      var embeds = await getEmbeds(tab.id);
      return sendResponse({ ok: true, embeds: embeds || [], tabId: tab.id, pageUrl: tab.url });
    }

    if (type === 'TRY_DOWNLOAD' || type === 'DIAGNOSE_VIDEO') {
      var settings = await chrome.storage.local.get(['allowedHost']);
      if (!settings.allowedHost) return sendResponse({ ok: false, message: 'Primero guarda el dominio permitido en el popup.' });
      var tabId = payload.tabId;
      var pageUrl = payload.pageUrl;
      if (!hostAllowed(pageUrl, settings.allowedHost)) {
        return sendResponse({ ok: false, message: 'La pagina no coincide con el dominio permitido (' + settings.allowedHost + ').' });
      }
      if (!payload.vimeoId) return sendResponse({ ok: false, message: 'Sin Vimeo ID.' });

      var result = await getConfig(tabId, payload.vimeoId);
      if (!result || !result.config) {
        return sendResponse({ ok: false, message: '\u274c ' + (result && result.error || 'No se obtuvo playerConfig del iframe.') });
      }

      var cfg = result.config;
      var candidates = parseCandidates(cfg);
      var direct = candidates.filter(function (c) { return /progressive|download/.test(c.source); });
      var streams = candidates.filter(function (c) { return /hls|dash/.test(c.source); });

      if (type === 'DIAGNOSE_VIDEO') {
        return sendResponse({
          ok: true,
          message: '\u2705 Config OK · "' + (cfg.video && cfg.video.title || 'sin titulo') + '"
\u25b6 MP4 directos: ' + direct.length + ' · Streaming: ' + streams.length + '
\u25b6 Calidades: ' + (direct.map(function (d) { return d.quality + (d.height ? 'p' : ''); }).join(', ') || 'ninguna') + '
\u25b6 URLs: ' + direct.slice(0, 2).map(function (d) { return d.url.slice(0, 60) + '...'; }).join(' | ')
        });
      }

      var chosen = pickBest(candidates, payload.preferredQuality);
      var title = safeFilename(payload.preferredName || (cfg.video && cfg.video.title) || payload.titleHint || ('video-' + payload.vimeoId));

      if (chosen && chosen.url) {
        var ext = /webm/i.test(chosen.mime || '') ? 'webm' : 'mp4';
        try {
          await chrome.downloads.download({ url: chosen.url, filename: title + '.' + ext, saveAs: true, conflictAction: 'uniquify' });
          return sendResponse({ ok: true, message: '\u2705 Descarga iniciada \u00b7 ' + chosen.quality + (chosen.height ? 'p' : '') + (chosen.size ? ' \u00b7 ~' + Math.round(chosen.size / 1024 / 1024) + ' MB' : '') });
        } catch (e) {
          return sendResponse({ ok: false, message: 'Error al descargar: ' + e.message });
        }
      }
      if (streams.length) return sendResponse({ ok: false, message: '\u26a0\ufe0f Solo HLS/DASH disponible. Vimeo no expone MP4 directo en este plan o video.' });
      return sendResponse({ ok: false, message: '\u274c Sin archivos descargables en el config.' });
    }
  })();
  return true;
});
