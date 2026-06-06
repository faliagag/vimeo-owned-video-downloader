/* background.js v8.3
 * - triggerBlobDownload: usa protocolo chunked (DOWNLOAD_META + DOWNLOAD_CHUNK x N + DOWNLOAD_FINALIZE)
 *   en vez de Array.from(uint8array) completo -> resuelve RangeError con videos grandes
 * - ensureFloater: verifica DOM id (no window flag)
 * - sendProgress: siempre incluye __videoId y __title
 */
'use strict';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB por chunk

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

function sendProgress(msg, pct, tabId, videoId, title) {
  const data = { type: 'CONVERT_PROGRESS', message: msg, pct: pct ?? -1, __videoId: String(videoId || ''), __title: title || '' };
  chrome.runtime.sendMessage(data).catch(() => {});
  if (tabId) chrome.tabs.sendMessage(tabId, data).catch(() => {});
}

async function ensureFloater(tabId) {
  try {
    const exists = await runInPage(tabId, () => !!document.getElementById('__vdf_wrap__'));
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['floater.css'] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['floater.js'] });
    // Si ya existia contenedor, floater.js sale temprano pero registra el listener
  } catch (e) {
    console.warn('[VDF] ensureFloater:', e.message);
  }
}

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
function pickBestHls(c)    { return c.find(x => x.source === 'hls') || null; }

async function resolveM3u8(url, referer, tabId, videoId, title) {
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
      const bw  = bwM ? parseInt(bwM[1]) : 0;
      const uri = (lines[i + 1] || '').trim();
      if (uri && !uri.startsWith('#')) variants.push({ bw, uri });
    }
  }
  if (!variants.length) throw new Error('Sin variantes en el manifiesto.');
  variants.sort((a, b) => b.bw - a.bw);
  const best = variants[0].uri.startsWith('http') ? variants[0].uri : new URL(variants[0].uri, url).href;
  sendProgress('Variante ' + Math.round(variants[0].bw / 1000) + ' kbps…', 5, tabId, videoId, title);
  const res2 = await fetch(best, { headers: h });
  if (!res2.ok) throw new Error('Variante HTTP ' + res2.status);
  return { url: best, text: await res2.text() };
}

async function downloadSegments(manifestUrl, manifestText, referer, tabId, videoId, title) {
  const h = referer ? { 'Referer': referer } : {};
  const lines = manifestText.split('\n').map(l => l.trim());
  const segs  = lines.filter(l => l && !l.startsWith('#'));
  if (!segs.length) throw new Error('Sin segmentos en el manifiesto.');
  const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  const chunks = []; let totalBytes = 0;
  for (let j = 0; j < segs.length; j++) {
    const segUrl = segs[j].startsWith('http') ? segs[j] : base + segs[j];
    if (j % 5 === 0 || j === segs.length - 1) {
      const pct = Math.round((j / segs.length) * 60) + 5;
      sendProgress('Seg ' + (j + 1) + '/' + segs.length, pct, tabId, videoId, title);
    }
    let attempts = 4;
    while (attempts-- > 0) {
      try {
        const r = await fetch(segUrl, { headers: h });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = new Uint8Array(await r.arrayBuffer());
        chunks.push(buf); totalBytes += buf.length; break;
      } catch (e) {
        if (attempts === 0) throw new Error('Seg ' + (j + 1) + ' fallido: ' + e.message);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  const sizeMB = Math.round(totalBytes / 1024 / 1024);
  sendProgress('Ensamblando (' + sizeMB + ' MB)…', 68, tabId, videoId, title);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return merged;
}

// v8.3: envia el buffer en chunks de 4MB, no como Array.from completo
async function triggerBlobDownload(uint8array, filename, mime, tabId, videoId, title) {
  return new Promise(async (resolve, reject) => {
    sendProgress('Abriendo descargador…', 72, tabId, videoId, title);
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html'), active: false });
    const dlTabId = tab.id;
    const cleanup = () => chrome.tabs.remove(dlTabId).catch(() => {});

    const t1 = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onReady);
      cleanup();
      reject(new Error('Timeout esperando downloader (20s).'));
    }, 20000);

    async function onReady(msg, sender) {
      if (msg?.type !== 'DOWNLOADER_READY' || sender.tab?.id !== dlTabId) return;
      clearTimeout(t1);
      chrome.runtime.onMessage.removeListener(onReady);

      try {
        // 1. Enviar metadata
        const totalChunks = Math.ceil(uint8array.length / CHUNK_SIZE);
        sendProgress('Enviando (' + Math.round(uint8array.length / 1024 / 1024) + ' MB en ' + totalChunks + ' partes)…', 74, tabId, videoId, title);
        await chrome.tabs.sendMessage(dlTabId, { type: 'DOWNLOAD_META', filename, mime, totalChunks });

        // 2. Enviar chunks
        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end   = Math.min(start + CHUNK_SIZE, uint8array.length);
          const slice = uint8array.slice(start, end);
          // Convertir solo este chunk pequeño a array normal
          const arr = [];
          for (let k = 0; k < slice.length; k++) arr.push(slice[k]);
          await chrome.tabs.sendMessage(dlTabId, { type: 'DOWNLOAD_CHUNK', index: i, data: arr });
          const pct = 74 + Math.round(((i + 1) / totalChunks) * 20);
          sendProgress('Parte ' + (i + 1) + '/' + totalChunks, pct, tabId, videoId, title);
        }

        // 3. Finalizar
        sendProgress('Disparando descarga…', 95, tabId, videoId, title);
        await chrome.tabs.sendMessage(dlTabId, { type: 'DOWNLOAD_FINALIZE' });

        // 4. Esperar confirmacion
        const t2 = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(onDone);
          cleanup();
          reject(new Error('Timeout confirmacion descarga (30s).'));
        }, 30000);

        function onDone(m2, s2) {
          if (s2.tab?.id !== dlTabId) return;
          if (m2?.type === 'DOWNLOAD_STARTED' || m2?.type === 'DOWNLOAD_ERROR') {
            clearTimeout(t2);
            chrome.runtime.onMessage.removeListener(onDone);
            cleanup();
            if (m2.type === 'DOWNLOAD_STARTED') resolve();
            else reject(new Error(m2.error || 'Error en descargador.'));
          }
        }
        chrome.runtime.onMessage.addListener(onDone);

      } catch(e) {
        cleanup();
        reject(new Error('Error enviando chunks: ' + e.message));
      }
    }
    chrome.runtime.onMessage.addListener(onReady);
  });
}

async function convertHls(hlsUrl, title, referer, tabId, videoId) {
  sendProgress('Resolviendo manifiesto…', 2, tabId, videoId, title);
  const manifest = await resolveM3u8(hlsUrl, referer, tabId, videoId, title);
  const tsData   = await downloadSegments(manifest.url, manifest.text, referer, tabId, videoId, title);
  const sizeMB   = Math.round(tsData.length / 1024 / 1024);
  await triggerBlobDownload(tsData, title + '.ts', 'video/mp2t', tabId, videoId, title);
  sendProgress('\u2705 Descarga iniciada (' + sizeMB + ' MB)', 100, tabId, videoId, title);
  return { ok: true, size: sizeMB, filename: title + '.ts' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { type, payload } = msg || {};

    if (type === 'GET_EMBEDS') {
      const tab = await getActiveTab();
      if (!tab) return sendResponse({ ok: false, message: 'Sin pesta\u00f1a activa.' });
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
      return sendResponse({
        ok: true,
        filesKeys: r.config?.request?.files ? Object.keys(r.config.request.files) : (r.config?.files ? Object.keys(r.config.files) : []),
        candidates: cands,
        videoTitle: r.config?.video?.title || ''
      });
    }

    if (type === 'TRY_DOWNLOAD' || type === 'DIAGNOSE_VIDEO') {
      const { allowedHost } = await chrome.storage.local.get(['allowedHost']);
      if (!allowedHost) return sendResponse({ ok: false, message: 'Primero guarda el dominio permitido.' });
      if (!hostAllowed(payload.pageUrl, allowedHost)) return sendResponse({ ok: false, message: 'Dominio no permitido: ' + new URL(payload.pageUrl).hostname });
      if (!payload.vimeoId) return sendResponse({ ok: false, message: 'Sin Vimeo ID.' });
      const result = await getConfig(payload.tabId, payload.vimeoId);
      if (!result?.config) return sendResponse({ ok: false, message: '\u274c Sin playerConfig.' });
      const cfg = result.config;
      const candidates = parseCandidates(cfg);
      const direct = pickBestDirect(candidates);
      const hls    = pickBestHls(candidates);
      const videoTitle = cfg?.video?.title || ('video-' + payload.vimeoId);
      const title      = safeFilename(payload.preferredName || videoTitle);
      if (type === 'DIAGNOSE_VIDEO') {
        return sendResponse({ ok: true, message: '\u2705 "' + videoTitle + '" | MP4: ' + (direct ? direct.source + ' ' + direct.quality : 'NO') + ' | HLS: ' + (hls ? 'S\u00cd' : 'NO') + ' | Candidatos: ' + candidates.length });
      }
      if (direct?.url) {
        try {
          await chrome.downloads.download({ url: direct.url, filename: title + '.mp4', saveAs: false, conflictAction: 'uniquify' });
          sendProgress('\u2705 MP4 directo iniciado.', 100, payload.tabId, payload.vimeoId, title);
          return sendResponse({ ok: true, message: '\u2705 Descarga MP4 directa iniciada.' });
        } catch (e) { return sendResponse({ ok: false, message: 'Error MP4: ' + e.message }); }
      }
      if (hls?.url) {
        return sendResponse({ ok: true, converting: true, hlsUrl: hls.url, title, pageUrl: payload.pageUrl, tabId: payload.tabId, videoId: payload.vimeoId, message: '\u23f3 Iniciando HLS…' });
      }
      return sendResponse({ ok: false, message: '\u274c Sin archivos descargables.' });
    }

    if (type === 'CONVERT_HLS') {
      try {
        const res = await convertHls(payload.hlsUrl, payload.title, payload.referer, payload.tabId, payload.videoId);
        return sendResponse({ ok: true, message: '\u2705 ' + res.filename + ' (' + res.size + ' MB)' });
      } catch (e) {
        sendProgress('\u274c ' + e.message, -1, payload.tabId, payload.videoId, payload.title);
        return sendResponse({ ok: false, message: '\u274c ' + e.message });
      }
    }
  })();
  return true;
});
