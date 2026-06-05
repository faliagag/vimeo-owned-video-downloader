/* background.js - Service Worker MV3 v6.5
 * Conversor HLS->MP4 nativo puro: descarga segmentos TS,
 * construye un MP4 ISO Base Media File Format (fragmentado) sin librerias externas.
 * Estrategia: descarga chunks TS -> los reempaqueta en un MP4 usando Blob + MediaSource (via tab)
 * o los descarga como .ts concatenado si MediaSource no esta disponible en SW.
 */

function safeFilename(name) {
  return (name || 'video-vimeo').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 160);
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
  var results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fn, args: args || [] });
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
    if (Array.isArray(obj)) { obj.forEach(function (i) { deepMp4(i, d + 1); }); return; }
    if (typeof obj === 'object') Object.values(obj).forEach(function (v) { deepMp4(v, d + 1); });
  }
  deepMp4(config, 0);
  var seen = {};
  return out.filter(function (c) { if (!c.url || seen[c.url]) return false; seen[c.url] = true; return true; });
}
function pickBestDirect(candidates) {
  var d = candidates.filter(function (c) { return /progressive|download|deep/.test(c.source); });
  return d.sort(function (a, b) { return (b.height || 0) - (a.height || 0); })[0] || null;
}
function pickBestHls(candidates) {
  return candidates.find(function (c) { return c.source === 'hls'; }) || null;
}
async function getActiveTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

/* ---- Utilidad: enviar progreso al popup ---- */
function sendProgress(msg) {
  chrome.runtime.sendMessage({ type: 'CONVERT_PROGRESS', message: msg }).catch(function () {});
}

/* ---- Resolver manifiesto HLS maestro -> URL de la mejor variante ---- */
async function resolveM3u8(url, referer) {
  var res = await fetch(url, { headers: { 'Referer': referer || '' } });
  if (!res.ok) throw new Error('Error descargando manifiesto: HTTP ' + res.status);
  var text = await res.text();
  if (!text.includes('#EXT-X-STREAM-INF')) return { url: url, text: text };
  var lines = text.split('\n');
  var variants = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      var bwM = lines[i].match(/BANDWIDTH=(\d+)/);
      var bw = bwM ? parseInt(bwM[1]) : 0;
      var uri = (lines[i + 1] || '').trim();
      if (uri && !uri.startsWith('#')) variants.push({ bw, uri });
    }
  }
  if (!variants.length) throw new Error('No se encontraron variantes en el manifiesto maestro.');
  variants.sort(function (a, b) { return b.bw - a.bw; });
  var best = variants[0].uri.startsWith('http') ? variants[0].uri : new URL(variants[0].uri, url).href;
  sendProgress('Variante ' + Math.round(variants[0].bw / 1000) + ' kbps seleccionada...');
  var res2 = await fetch(best, { headers: { 'Referer': referer || '' } });
  if (!res2.ok) throw new Error('Error descargando variante: HTTP ' + res2.status);
  return { url: best, text: await res2.text() };
}

/* ---- Descargar todos los segmentos TS y concatenarlos ---- */
async function downloadSegments(manifestUrl, manifestText, referer) {
  var lines = manifestText.split('\n').map(function (l) { return l.trim(); });
  var segs = lines.filter(function (l) { return l && !l.startsWith('#'); });
  if (!segs.length) throw new Error('No se encontraron segmentos en el manifiesto.');
  var base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  var chunks = [];
  var totalBytes = 0;
  for (var j = 0; j < segs.length; j++) {
    var segUrl = segs[j].startsWith('http') ? segs[j] : base + segs[j];
    if (j % 5 === 0 || j === segs.length - 1) {
      sendProgress('Descargando segmento ' + (j + 1) + ' / ' + segs.length + '...');
    }
    var r = await fetch(segUrl, { headers: { 'Referer': referer || '' } });
    if (!r.ok) throw new Error('Error en segmento ' + (j + 1) + ': HTTP ' + r.status);
    var buf = new Uint8Array(await r.arrayBuffer());
    chunks.push(buf);
    totalBytes += buf.length;
  }
  sendProgress('Ensamblando ' + segs.length + ' segmentos (' + Math.round(totalBytes / 1024 / 1024) + ' MB)...');
  var merged = new Uint8Array(totalBytes);
  var offset = 0;
  chunks.forEach(function (c) { merged.set(c, offset); offset += c.length; });
  return merged;
}

/* ---- Disparar descarga desde el Service Worker ---- */
async function triggerDownload(data, filename, mimeType) {
  /* Convertir Uint8Array a base64 URL porque SW no tiene acceso a createObjectURL */
  var chunkSize = 8192;
  var binary = '';
  for (var i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, data.subarray(i, i + chunkSize));
  }
  var base64 = 'data:' + mimeType + ';base64,' + btoa(binary);
  await chrome.downloads.download({
    url: base64,
    filename: filename,
    saveAs: false,
    conflictAction: 'uniquify'
  });
}

/* ---- Conversor principal: HLS -> descarga ---- */
async function convertHls(hlsUrl, title, referer) {
  sendProgress('Resolviendo manifiesto HLS...');
  var manifest = await resolveM3u8(hlsUrl, referer);
  var tsData = await downloadSegments(manifest.url, manifest.text, referer);
  sendProgress('Iniciando descarga del archivo TS (' + Math.round(tsData.length / 1024 / 1024) + ' MB)...');
  /* Descargar como .ts: el navegador puede reproducirlo y VLC/MPC lo abre directamente.
     Nota: reempaquetar TS->MP4 sin ffmpeg requiere parsear cabeceras PAT/PMT/PES
     lo cual es complejo. Descargamos el TS nativo que es reproducible universalmente. */
  await triggerDownload(tsData, title + '.ts', 'video/mp2t');
  sendProgress('\u2705 Descarga completada (' + Math.round(tsData.length / 1024 / 1024) + ' MB).');
  return { ok: true, size: Math.round(tsData.length / 1024 / 1024), filename: title + '.ts' };
}

/* ======= HANDLER PRINCIPAL ======= */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'CONVERT_PROGRESS') {
    chrome.runtime.sendMessage({ type: 'CONVERT_PROGRESS', message: msg.message }).catch(function () {});
    return;
  }
  (async function () {
    var type = msg && msg.type;
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
      return sendResponse({ ok: true, rawKeys: Object.keys(cfg0), requestKeys: cfg0.request ? Object.keys(cfg0.request) : [], filesKeys: (cfg0.request && cfg0.request.files) ? Object.keys(cfg0.request.files) : (cfg0.files ? Object.keys(cfg0.files) : []), candidates: cands0, videoTitle: (cfg0.video && cfg0.video.title) || '' });
    }

    if (type === 'TRY_DOWNLOAD' || type === 'DIAGNOSE_VIDEO') {
      var settings = await chrome.storage.local.get(['allowedHost']);
      if (!settings.allowedHost) return sendResponse({ ok: false, message: 'Primero guarda el dominio permitido.' });
      if (!hostAllowed(payload.pageUrl, settings.allowedHost)) return sendResponse({ ok: false, message: 'Dominio no permitido.' });
      if (!payload.vimeoId) return sendResponse({ ok: false, message: 'Sin Vimeo ID.' });
      var result = await getConfig(payload.tabId, payload.vimeoId);
      if (!result || !result.config) return sendResponse({ ok: false, message: '\u274c Sin playerConfig.' });
      var cfg = result.config;
      var candidates = parseCandidates(cfg);
      var direct = pickBestDirect(candidates);
      var hls = pickBestHls(candidates);
      var videoTitle = (cfg.video && cfg.video.title) || ('video-' + payload.vimeoId);
      var title = safeFilename(payload.preferredName || videoTitle);
      if (type === 'DIAGNOSE_VIDEO') {
        return sendResponse({ ok: true, message: '\u2705 "' + videoTitle + '" | MP4: ' + (direct ? direct.source : 'NO') + ' | HLS: ' + (hls ? 'SI' : 'NO') });
      }
      if (direct && direct.url) {
        try {
          await chrome.downloads.download({ url: direct.url, filename: title + '.mp4', saveAs: false, conflictAction: 'uniquify' });
          return sendResponse({ ok: true, message: '\u2705 Descarga MP4 directa iniciada.' });
        } catch (e) { return sendResponse({ ok: false, message: 'Error MP4: ' + e.message }); }
      }
      if (hls && hls.url) {
        return sendResponse({ ok: true, converting: true, hlsUrl: hls.url, title: title, pageUrl: payload.pageUrl, message: '\u23f3 Iniciando descarga HLS...' });
      }
      return sendResponse({ ok: false, message: '\u274c Sin archivos descargables.' });
    }

    if (type === 'CONVERT_HLS') {
      try {
        var res = await convertHls(payload.hlsUrl, payload.title, payload.referer);
        return sendResponse({ ok: true, message: '\u2705 Archivo descargado: ' + res.filename + ' (' + res.size + ' MB). VLC y la mayoria de reproductores lo abren directamente.' });
      } catch (e) {
        return sendResponse({ ok: false, message: '\u274c Error en conversion: ' + e.message });
      }
    }
  })();
  return true;
});
