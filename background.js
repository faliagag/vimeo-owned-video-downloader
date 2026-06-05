/* background.js v8.0
 * Arquitectura:
 * - Inyecta floater.js en la pestaña del usuario (barra flotante persistente)
 * - La descarga corre en el SW independiente del popup
 * - Progreso enviado TANTO al popup (si está abierto) COMO al floater en la pestaña
 */
'use strict';

function safeFilename(n) {
  return (n || 'video-vimeo').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 160);
}
function normalizeHost(v) {
  return (v || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}
function hostAllowed(pageUrl, allowedHost) {
  try {
    const h = new URL(pageUrl).hostname.toLowerCase();
    const a = normalizeHost(allowedHost);
    return !!a && (h === a || h.endsWith('.' + a));
  } catch (_) { return false; }
}
async function runInPage(tabId, fn, args) {
  const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fn, args: args || [] });
  return r?.[0]?.result;
}
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

// Enviar progreso al popup Y al floater en la pestaña
function sendProgress(msg, pct, tabId) {
  const data = { type: 'CONVERT_PROGRESS', message: msg, pct: pct ?? -1 };
  chrome.runtime.sendMessage(data).catch(() => {});
  if (tabId) chrome.tabs.sendMessage(tabId, data).catch(() => {});
}

// Inyectar el floater en la pestaña si no está ya
async function ensureFloater(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['floater.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['floater.css']
    });
  } catch (_) {}
}

// Escanear embeds
async function getEmbeds(tabId) {
  return runInPage(tabId, () =>
    typeof window.__scanVimeoEmbedsNow === 'function'
      ? window.__scanVimeoEmbedsNow()
      : (window.__VIMEO_EMBEDS__ || [])
  );
}
async function getConfig(tabId, videoId) {
  return runInPage(tabId, async (vid) =>
    typeof window.__getVimeoConfig === 'function'
      ? window.__getVimeoConfig(vid)
      : { config: null, error: 'page_scanner.js no cargado.' },
    [videoId]
  );
}

// Parsear candidatos
function parseCandidates(config) {
  const out = [], seen = new Set();
  function add(c) { if (c?.url && !seen.has(c.url)) { seen.add(c.url); out.push(c); } }
  const prog = config?.request?.files?.progressive || config?.files?.progressive || [];
  if (Array.isArray(prog)) prog.forEach(f => { if (f?.url) add({ source: 'progressive', quality: String(f.quality || f.height || 'sd'), height: Number(f.height || 0), mime: 'video/mp4', url: f.url, size: f.size || null }); });
  const dl = config?.download || config?.request?.files?.download || [];
  if (Array.isArray(dl)) dl.forEach(f => { const url = f?.link || f?.url; if (url) add({ source: 'download', quality: String(f.quality || f.height || 'sd'), height: Number(f.height || 0), mime: 'video/mp4', url, size: f.size || null }); });
  const hls = config?.request?.files?.hls?.cdns || config?.files?.hls?.cdns || {};
  Object.values(hls).forEach(c => { if (c?.url) add({ source: 'hls', quality: 'hls', height: 0, mime: 'application/x-mpegURL', url: c.url }); });
  const dash = config?.request?.files?.dash?.cdns || config?.files?.dash?.cdns || {};
  Object.values(dash).forEach(c => { if (c?.url) add({ source: 'dash', quality: 'dash', height: 0, mime: 'application/dash+xml', url: c.url }); });
  function deepMp4(obj, d) {
    if (!obj || d > 6) return;
    if (typeof obj === 'string') { if (/\.mp4/i.test(obj) && /^https?:\/\//.test(obj)) add({ source: 'deep', quality: 'unknown', height: 0, mime: 'video/mp4', url: obj }); return; }
    if (Array.isArray(obj)) { obj.forEach(i => deepMp4(i, d + 1)); return; }
    if (typeof obj === 'object') Object.values(obj).forEach(v => deepMp4(v, d + 1));
  }
  deepMp4(config, 0);
  return out;
}
function pickBestDirect(c) { return c.filter(x => /progressive|download|deep/.test(x.source)).sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null; }
function pickBestHls(c) { return c.find(x => x.source === 'hls') || null; }

// Resolver manifiesto HLS
async function resolveM3u8(url, referer, tabId) {
  const h = referer ? { 'Referer': referer } : {};
  const res = await fetch(url, { headers: h });
  if (!res.ok) throw new Error('Manifiesto HTTP ' + res.status);
  const text = await res.text();
  if (!text.includes('#EXT-X-STREAM-INF')) return { url, text };
  const lines = text.split('\n');
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwM = lines[i].match(/BANDWIDTH=(\d+)/);
      const bw = bwM ? parseInt(bwM[1]) : 0;
      const uri = (lines[i + 1] || '').trim();
      if (uri && !uri.startsWith('#')) variants.push({ bw, uri });
    }
  }
  if (!variants.length) throw new Error('Sin variantes en el manifiesto.');
  variants.sort((a, b) => b.bw - a.bw);
  const best = variants[0].uri.startsWith('http') ? variants[0].uri : new URL(variants[0].uri, url).href;
  sendProgress('Variante ' + Math.round(variants[0].bw / 1000) + ' kbps seleccionada…', 5, tabId);
  const res2 = await fetch(best, { headers: h });
  if (!res2.ok) throw new Error('Variante HTTP ' + res2.status);
  return { url: best, text: await res2.text() };
}

// Descargar segmentos
async function downloadSegments(manifestUrl, manifestText, referer, tabId) {
  const h = referer ? { 'Referer': referer } : {};
  const lines = manifestText.split('\n').map(l => l.trim());
  const segs = lines.filter(l => l && !l.startsWith('#'));
  if (!segs.length) throw new Error('Sin segmentos en el manifiesto.');
  const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  const chunks = []; let totalBytes = 0;
  for (let j = 0; j < segs.length; j++) {
    const segUrl = segs[j].startsWith('http') ? segs[j] : base + segs[j];
    if (j % 8 === 0 || j === segs.length - 1) {
      const pct = Math.round((j / segs.length) * 60) + 5;
      sendProgress(`Segmento ${j + 1} / ${segs.length}…`, pct, tabId);
    }
    let attempts = 3;
    while (attempts-- > 0) {
      try {
        const r = await fetch(segUrl, { headers: h });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = new Uint8Array(await r.arrayBuffer());
        chunks.push(buf); totalBytes += buf.length; break;
      } catch (e) {
        if (attempts === 0) throw new Error(`Segmento ${j + 1} fallido: ${e.message}`);
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }
  sendProgress('Ensamblando ' + segs.length + ' segs (' + Math.round(totalBytes / 1024 / 1024) + ' MB)…', 68, tabId);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return merged;
}

// Disparar descarga vía tab auxiliar (Blob URL real, sin límite 2MB)
async function triggerBlobDownload(uint8array, filename, mime, tabId) {
  return new Promise(async (resolve, reject) => {
    sendProgress('Preparando descarga…', 72, tabId);
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html'), active: false });
    const dlTabId = tab.id;
    function onReady(msg, sender) {
      if (msg?.type === 'DOWNLOADER_READY' && sender.tab?.id === dlTabId) {
        chrome.runtime.onMessage.removeListener(onReady);
        sendProgress('Transfiriendo buffer…', 76, tabId);
        chrome.tabs.sendMessage(dlTabId, {
          type: 'TRIGGER_DOWNLOAD', filename, mime,
          buffer: Array.from(uint8array)
        }).then(() => {
          function onDone(m2, s2) {
            if ((m2?.type === 'DOWNLOAD_STARTED' || m2?.type === 'DOWNLOAD_ERROR') && s2.tab?.id === dlTabId) {
              chrome.runtime.onMessage.removeListener(onDone);
              chrome.tabs.remove(dlTabId).catch(() => {});
              if (m2.type === 'DOWNLOAD_STARTED') resolve();
              else reject(new Error(m2.error || 'Error en descargador.'));
            }
          }
          chrome.runtime.onMessage.addListener(onDone);
          setTimeout(() => { chrome.runtime.onMessage.removeListener(onDone); chrome.tabs.remove(dlTabId).catch(() => {}); reject(new Error('Timeout descargador 30s.')); }, 30000);
        }).catch(e => { chrome.tabs.remove(dlTabId).catch(() => {}); reject(new Error('sendMessage: ' + e.message)); });
      }
    }
    chrome.runtime.onMessage.addListener(onReady);
    setTimeout(() => { chrome.runtime.onMessage.removeListener(onReady); chrome.tabs.remove(dlTabId).catch(() => {}); reject(new Error('Timeout: downloader.html no cargó en 15s.')); }, 15000);
  });
}

// Conversor HLS → descarga
async function convertHls(hlsUrl, title, referer, tabId) {
  sendProgress('Resolviendo manifiesto HLS…', 2, tabId);
  const manifest = await resolveM3u8(hlsUrl, referer, tabId);
  const tsData = await downloadSegments(manifest.url, manifest.text, referer, tabId);
  const sizeMB = Math.round(tsData.length / 1024 / 1024);
  await triggerBlobDownload(tsData, title + '.ts', 'video/mp2t', tabId);
  sendProgress('✅ Descarga iniciada (' + sizeMB + ' MB)', 100, tabId);
  return { ok: true, size: sizeMB, filename: title + '.ts' };
}

// MESSAGE HANDLER
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { type, payload } = msg || {};

    if (type === 'GET_EMBEDS') {
      const tab = await getActiveTab();
      if (!tab) return sendResponse({ ok: false, message: 'Sin pestaña activa.' });
      const embeds = await getEmbeds(tab.id);
      return sendResponse({ ok: true, embeds: embeds || [], tabId: tab.id, pageUrl: tab.url });
    }

    if (type === 'INJECT_FLOATER') {
      const tab = await getActiveTab();
      if (!tab) return sendResponse({ ok: false });
      await ensureFloater(tab.id);
      return sendResponse({ ok: true });
    }

    if (type === 'GET_RAW_CONFIG') {
      const r = await getConfig(payload.tabId, payload.vimeoId);
      if (!r?.config) return sendResponse({ ok: false, message: r?.error || 'Sin config.' });
      const cands = parseCandidates(r.config);
      return sendResponse({ ok: true, filesKeys: r.config?.request?.files ? Object.keys(r.config.request.files) : (r.config?.files ? Object.keys(r.config.files) : []), candidates: cands, videoTitle: r.config?.video?.title || '' });
    }

    if (type === 'TRY_DOWNLOAD' || type === 'DIAGNOSE_VIDEO') {
      const { allowedHost } = await chrome.storage.local.get(['allowedHost']);
      if (!allowedHost) return sendResponse({ ok: false, message: 'Primero guarda el dominio permitido.' });
      if (!hostAllowed(payload.pageUrl, allowedHost)) return sendResponse({ ok: false, message: 'Dominio no permitido: ' + new URL(payload.pageUrl).hostname });
      if (!payload.vimeoId) return sendResponse({ ok: false, message: 'Sin Vimeo ID.' });
      const result = await getConfig(payload.tabId, payload.vimeoId);
      if (!result?.config) return sendResponse({ ok: false, message: '❌ Sin playerConfig. ¿Está interceptando el iframe?' });
      const cfg = result.config;
      const candidates = parseCandidates(cfg);
      const direct = pickBestDirect(candidates);
      const hls = pickBestHls(candidates);
      const videoTitle = cfg?.video?.title || ('video-' + payload.vimeoId);
      const title = safeFilename(payload.preferredName || videoTitle);
      if (type === 'DIAGNOSE_VIDEO') {
        return sendResponse({ ok: true, message: `✅ "${videoTitle}" | MP4: ${direct ? direct.source + ' ' + direct.quality : 'NO'} | HLS: ${hls ? 'SÍ' : 'NO'} | Candidatos: ${candidates.length}` });
      }
      if (direct?.url) {
        try {
          await chrome.downloads.download({ url: direct.url, filename: title + '.mp4', saveAs: false, conflictAction: 'uniquify' });
          sendProgress('✅ Descarga MP4 directa iniciada.', 100, payload.tabId);
          return sendResponse({ ok: true, message: '✅ Descarga MP4 directa iniciada.' });
        } catch (e) { return sendResponse({ ok: false, message: 'Error MP4: ' + e.message }); }
      }
      if (hls?.url) {
        return sendResponse({ ok: true, converting: true, hlsUrl: hls.url, title, pageUrl: payload.pageUrl, tabId: payload.tabId, message: '⏳ Iniciando descarga HLS…' });
      }
      return sendResponse({ ok: false, message: '❌ Sin archivos descargables. Usa 🔬 Config.' });
    }

    if (type === 'CONVERT_HLS') {
      try {
        const res = await convertHls(payload.hlsUrl, payload.title, payload.referer, payload.tabId);
        return sendResponse({ ok: true, message: `✅ ${res.filename} (${res.size} MB)` });
      } catch (e) {
        sendProgress(null, -1, payload.tabId);
        return sendResponse({ ok: false, message: '❌ ' + e.message });
      }
    }
  })();
  return true;
});
