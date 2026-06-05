/* background.js - Service Worker MV3 v7.0
 * Arquitectura blindada:
 * - Descarga segmentos HLS en el SW (tiene host_permissions <all_urls>, sin CORS)
 * - Transfiere el ArrayBuffer a una pestaña auxiliar (downloader.html)
 * - La pestaña crea un Blob URL real (sin límite de 2MB) y dispara la descarga
 * - El SW nunca usa data: URLs para archivos grandes
 */

'use strict';

// ─── Utilidades ───────────────────────────────────────────────────────────────
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
    const h = new URL(pageUrl).hostname.toLowerCase();
    const a = normalizeHost(allowedHost);
    return !!a && (h === a || h.endsWith('.' + a));
  } catch (_) { return false; }
}
async function runInPage(tabId, fn, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: fn,
    args: args || []
  });
  return results?.[0]?.result;
}

// ─── Enviar progreso al popup ──────────────────────────────────────────────────
function sendProgress(msg, pct) {
  chrome.runtime.sendMessage({ type: 'CONVERT_PROGRESS', message: msg, pct: pct ?? -1 }).catch(() => {});
}

// ─── Obtener embeds desde la pestaña activa ────────────────────────────────────
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

// ─── Parsear candidatos de descarga ───────────────────────────────────────────
function parseCandidates(config) {
  const out = [];
  const seen = new Set();
  function add(c) {
    if (c?.url && !seen.has(c.url)) { seen.add(c.url); out.push(c); }
  }
  // Progressive MP4
  const prog = config?.request?.files?.progressive || config?.files?.progressive || [];
  if (Array.isArray(prog)) prog.forEach(f => {
    if (f?.url) add({ source: 'progressive', quality: String(f.quality || f.height || 'sd'),
      height: Number(f.height || 0), mime: 'video/mp4', url: f.url, size: f.size || null });
  });
  // Download links
  const dl = config?.download || config?.request?.files?.download || [];
  if (Array.isArray(dl)) dl.forEach(f => {
    const url = f?.link || f?.url;
    if (url) add({ source: 'download', quality: String(f.quality || f.height || 'sd'),
      height: Number(f.height || 0), mime: 'video/mp4', url, size: f.size || null });
  });
  // HLS
  const hls = config?.request?.files?.hls?.cdns || config?.files?.hls?.cdns || {};
  Object.values(hls).forEach(c => {
    if (c?.url) add({ source: 'hls', quality: 'hls', height: 0, mime: 'application/x-mpegURL', url: c.url });
  });
  // DASH
  const dash = config?.request?.files?.dash?.cdns || config?.files?.dash?.cdns || {};
  Object.values(dash).forEach(c => {
    if (c?.url) add({ source: 'dash', quality: 'dash', height: 0, mime: 'application/dash+xml', url: c.url });
  });
  // Deep scan MP4
  function deepMp4(obj, d) {
    if (!obj || d > 6) return;
    if (typeof obj === 'string') {
      if (/\.mp4/i.test(obj) && /^https?:\/\//.test(obj))
        add({ source: 'deep', quality: 'unknown', height: 0, mime: 'video/mp4', url: obj });
      return;
    }
    if (Array.isArray(obj)) { obj.forEach(i => deepMp4(i, d + 1)); return; }
    if (typeof obj === 'object') Object.values(obj).forEach(v => deepMp4(v, d + 1));
  }
  deepMp4(config, 0);
  return out;
}
function pickBestDirect(candidates) {
  return candidates
    .filter(c => /progressive|download|deep/.test(c.source))
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null;
}
function pickBestHls(candidates) {
  return candidates.find(c => c.source === 'hls') || null;
}
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

// ─── Resolver manifiesto HLS maestro → URL variante mejor calidad ─────────────
async function resolveM3u8(url, referer) {
  const headers = referer ? { 'Referer': referer } : {};
  const res = await fetch(url, { headers });
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
  if (!variants.length) throw new Error('Sin variantes en el manifiesto maestro.');
  variants.sort((a, b) => b.bw - a.bw);
  const best = variants[0].uri.startsWith('http')
    ? variants[0].uri
    : new URL(variants[0].uri, url).href;
  sendProgress('Variante seleccionada: ' + Math.round(variants[0].bw / 1000) + ' kbps', 5);
  const res2 = await fetch(best, { headers });
  if (!res2.ok) throw new Error('Variante HTTP ' + res2.status);
  return { url: best, text: await res2.text() };
}

// ─── Descargar todos los segmentos .ts y concatenarlos ────────────────────────
async function downloadSegments(manifestUrl, manifestText, referer) {
  const headers = referer ? { 'Referer': referer } : {};
  const lines = manifestText.split('\n').map(l => l.trim());
  const segs = lines.filter(l => l && !l.startsWith('#'));
  if (!segs.length) throw new Error('Sin segmentos en el manifiesto.');
  const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  const chunks = [];
  let totalBytes = 0;
  for (let j = 0; j < segs.length; j++) {
    const segUrl = segs[j].startsWith('http') ? segs[j] : base + segs[j];
    if (j % 10 === 0 || j === segs.length - 1) {
      const pct = Math.round((j / segs.length) * 60) + 5;
      sendProgress(`Segmento ${j + 1}/${segs.length}…`, pct);
    }
    let attempts = 3;
    while (attempts-- > 0) {
      try {
        const r = await fetch(segUrl, { headers });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = new Uint8Array(await r.arrayBuffer());
        chunks.push(buf);
        totalBytes += buf.length;
        break;
      } catch (e) {
        if (attempts === 0) throw new Error(`Segmento ${j + 1} fallido tras 3 intentos: ${e.message}`);
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }
  sendProgress('Ensamblando ' + segs.length + ' segmentos (' + Math.round(totalBytes / 1024 / 1024) + ' MB)…', 68);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return merged;
}

// ─── Abrir pestaña auxiliar y enviarle el buffer para descarga Blob ────────────
// CRÍTICO: Service Worker NO tiene acceso a URL.createObjectURL().
// La solución es abrir downloader.html (que sí es una página real),
// transferirle el ArrayBuffer via chrome.tabs.sendMessage y dejar que
// ella cree el Blob URL y dispare el <a download>.
async function triggerBlobDownload(uint8array, filename, mime) {
  return new Promise(async (resolve, reject) => {
    sendProgress('Abriendo descargador…', 70);
    const tab = await chrome.tabs.create({
      url: chrome.runtime.getURL('downloader.html'),
      active: false
    });
    const tabId = tab.id;
    // Esperar a que la pestaña esté lista
    function onReady(msg, sender) {
      if (msg?.type === 'DOWNLOADER_READY' && sender.tab?.id === tabId) {
        chrome.runtime.onMessage.removeListener(onReady);
        // Transferir buffer vía message (transferable)
        sendProgress('Transfiriendo buffer al descargador…', 75);
        chrome.tabs.sendMessage(tabId, {
          type: 'TRIGGER_DOWNLOAD',
          filename,
          mime,
          buffer: Array.from(uint8array)  // serializable por chrome.tabs.sendMessage
        }).then(() => {
          // Esperar confirmación de descarga iniciada
          function onDone(m2, s2) {
            if ((m2?.type === 'DOWNLOAD_STARTED' || m2?.type === 'DOWNLOAD_ERROR') && s2.tab?.id === tabId) {
              chrome.runtime.onMessage.removeListener(onDone);
              chrome.tabs.remove(tabId).catch(() => {});
              if (m2.type === 'DOWNLOAD_STARTED') resolve();
              else reject(new Error(m2.error || 'Error en descargador.'));
            }
          }
          chrome.runtime.onMessage.addListener(onDone);
          setTimeout(() => {
            chrome.runtime.onMessage.removeListener(onDone);
            chrome.tabs.remove(tabId).catch(() => {});
            reject(new Error('Timeout: descargador no respondió en 30s.'));
          }, 30000);
        }).catch(e => {
          chrome.tabs.remove(tabId).catch(() => {});
          reject(new Error('sendMessage al descargador: ' + e.message));
        });
      }
    }
    chrome.runtime.onMessage.addListener(onReady);
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onReady);
      chrome.tabs.remove(tabId).catch(() => {});
      reject(new Error('Timeout: downloader.html no cargó en 15s.'));
    }, 15000);
  });
}

// ─── Conversor principal HLS → descarga ───────────────────────────────────────
async function convertHls(hlsUrl, title, referer) {
  sendProgress('Resolviendo manifiesto HLS…', 2);
  const manifest = await resolveM3u8(hlsUrl, referer);
  const tsData = await downloadSegments(manifest.url, manifest.text, referer);
  const sizeMB = Math.round(tsData.length / 1024 / 1024);
  sendProgress('Iniciando descarga Blob (' + sizeMB + ' MB)…', 72);
  await triggerBlobDownload(tsData, title + '.ts', 'video/mp2t');
  sendProgress('✅ Descarga iniciada (' + sizeMB + ' MB)', 100);
  return { ok: true, size: sizeMB, filename: title + '.ts' };
}

// ─── Message handler principal ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { type, payload } = msg || {};

    if (type === 'GET_EMBEDS') {
      const tab = await getActiveTab();
      if (!tab) return sendResponse({ ok: false, message: 'Sin pestaña activa.' });
      const embeds = await getEmbeds(tab.id);
      return sendResponse({ ok: true, embeds: embeds || [], tabId: tab.id, pageUrl: tab.url });
    }

    if (type === 'GET_RAW_CONFIG') {
      const r = await getConfig(payload.tabId, payload.vimeoId);
      if (!r?.config) return sendResponse({ ok: false, message: r?.error || 'Sin config.' });
      const cands = parseCandidates(r.config);
      return sendResponse({
        ok: true,
        rawKeys: Object.keys(r.config),
        filesKeys: r.config?.request?.files ? Object.keys(r.config.request.files) : (r.config?.files ? Object.keys(r.config.files) : []),
        candidates: cands,
        videoTitle: r.config?.video?.title || ''
      });
    }

    if (type === 'TRY_DOWNLOAD' || type === 'DIAGNOSE_VIDEO') {
      const { allowedHost } = await chrome.storage.local.get(['allowedHost']);
      if (!allowedHost) return sendResponse({ ok: false, message: 'Primero guarda el dominio permitido.' });
      if (!hostAllowed(payload.pageUrl, allowedHost))
        return sendResponse({ ok: false, message: 'Dominio no permitido: ' + new URL(payload.pageUrl).hostname });
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
        const info = `✅ "${videoTitle}" | MP4: ${direct ? direct.source + ' ' + direct.quality : 'NO'} | HLS: ${hls ? 'SÍ' : 'NO'} | Total candidatos: ${candidates.length}`;
        return sendResponse({ ok: true, message: info });
      }
      // Intentar MP4 directo primero
      if (direct?.url) {
        try {
          await chrome.downloads.download({
            url: direct.url,
            filename: title + '.mp4',
            saveAs: false,
            conflictAction: 'uniquify'
          });
          return sendResponse({ ok: true, message: '✅ Descarga MP4 directa iniciada.' });
        } catch (e) {
          return sendResponse({ ok: false, message: 'Error MP4: ' + e.message });
        }
      }
      // HLS: señalar al popup para que inicie conversión
      if (hls?.url) {
        return sendResponse({
          ok: true, converting: true,
          hlsUrl: hls.url, title,
          pageUrl: payload.pageUrl,
          message: '⏳ Descargando HLS…'
        });
      }
      return sendResponse({ ok: false, message: '❌ Sin archivos descargables. Usa 🔬 Config para diagnóstico avanzado.' });
    }

    if (type === 'CONVERT_HLS') {
      try {
        const res = await convertHls(payload.hlsUrl, payload.title, payload.referer);
        return sendResponse({ ok: true, message: `✅ Descarga iniciada: ${res.filename} (${res.size} MB)` });
      } catch (e) {
        sendProgress(null);
        return sendResponse({ ok: false, message: '❌ ' + e.message });
      }
    }
  })();
  return true;
});
