// background.js v9.9
// Service Worker principal. Coordina deteccion HLS, descarga de segmentos
// y entrega al offscreen para concatenacion binaria.

const VERSION = '9.9.0';
let offscreenReady = false;
let offscreenCreating = false;

// ── Utilidades ──────────────────────────────────────────────────────────────

function logSW(tabId, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log('[SW]', msg);
  chrome.tabs.sendMessage(tabId, { type: 'LOG', msg: `[${ts}] ${msg}` }).catch(() => {});
}

async function ensureOffscreen() {
  if (offscreenReady) return;
  if (offscreenCreating) {
    await new Promise(r => setTimeout(r, 200));
    return ensureOffscreen();
  }
  offscreenCreating = true;
  try {
    const existing = await chrome.offscreen.hasDocument?.() ||
      await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then(c => c.length > 0).catch(() => false);
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Concatenar segmentos HLS en archivo TS'
      });
    }
    offscreenReady = true;
  } catch (e) {
    console.error('Error creando offscreen:', e);
  } finally {
    offscreenCreating = false;
  }
}

// ── Descarga de segmentos HLS ────────────────────────────────────────────────

async function fetchSegment(url, headers) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} en ${url}`);
  return resp.arrayBuffer();
}

async function fetchM3U8(url, headers) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`No se pudo obtener M3U8: HTTP ${resp.status}`);
  return resp.text();
}

function resolveUrl(base, relative) {
  try { return new URL(relative, base).href; } catch { return relative; }
}

async function downloadHLS(tabId, masterUrl, requestHeaders) {
  logSW(tabId, 'Obteniendo M3U8 maestro...');
  const masterText = await fetchM3U8(masterUrl, requestHeaders);
  const lines = masterText.split('\n').map(l => l.trim()).filter(Boolean);

  // Elegir la calidad mas alta (ultima entrada EXT-X-STREAM-INF)
  let playlistUrl = null;
  let bestBandwidth = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
      if (bw >= bestBandwidth && i + 1 < lines.length && !lines[i+1].startsWith('#')) {
        bestBandwidth = bw;
        playlistUrl = resolveUrl(masterUrl, lines[i+1]);
      }
    }
  }

  // Si no hay EXT-X-STREAM-INF, asumir que ya es un playlist de segmentos
  if (!playlistUrl) playlistUrl = masterUrl;

  logSW(tabId, `Playlist elegido (bandwidth=${bestBandwidth}): ${playlistUrl}`);
  const playlistText = await fetchM3U8(playlistUrl, requestHeaders);
  const segmentLines = playlistText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  if (segmentLines.length === 0) throw new Error('No se encontraron segmentos en el M3U8');

  logSW(tabId, `Descargando ${segmentLines.length} segmentos...`);
  const segments = [];
  for (let i = 0; i < segmentLines.length; i++) {
    const segUrl = resolveUrl(playlistUrl, segmentLines[i]);
    logSW(tabId, `[${i+1}/${segmentLines.length}] ${segUrl.split('/').pop()}`);
    const buf = await fetchSegment(segUrl, requestHeaders);
    segments.push(buf);
  }

  return segments;
}

// ── Handler principal de descarga ────────────────────────────────────────────

async function startDownload(tabId, hlsUrl, filename) {
  try {
    logSW(tabId, `Iniciando descarga v${VERSION}`);
    logSW(tabId, `HLS URL: ${hlsUrl}`);

    await ensureOffscreen();

    // Headers para las peticiones HLS
    const requestHeaders = {
      'Referer': 'https://player.vimeo.com/',
      'Origin': 'https://player.vimeo.com'
    };

    // Descargar segmentos
    const segments = await downloadHLS(tabId, hlsUrl, requestHeaders);
    logSW(tabId, `${segments.length} segmentos descargados. Enviando al offscreen...`);

    // Transferir al offscreen para concatenar
    // Usamos transferable objects para eficiencia de memoria
    const transferable = segments.map(s => s);
    const result = await chrome.runtime.sendMessage({
      type: 'CONVERT_TS_TO_MP4',
      segments: transferable,
      filename: filename || 'video_vimeo'
    });

    if (!result || !result.ok) {
      throw new Error(result?.error || 'Error en offscreen');
    }

    logSW(tabId, `Concatenacion lista (${(result.bytes/1024/1024).toFixed(2)} MB). Descargando...`);

    // Descargar usando data URL desde el Service Worker
    await chrome.downloads.download({
      url: result.dataUrl,
      filename: result.filename,
      saveAs: false
    });

    logSW(tabId, `✅ Descarga iniciada: ${result.filename}`);
    chrome.tabs.sendMessage(tabId, { type: 'DOWNLOAD_DONE', filename: result.filename }).catch(() => {});

  } catch (e) {
    console.error('[SW] Error:', e);
    logSW(tabId, `❌ Error: ${e.message}`);
    chrome.tabs.sendMessage(tabId, { type: 'DOWNLOAD_ERROR', error: e.message }).catch(() => {});
  }
}

// ── Listeners ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_LOG') {
    console.log('[Offscreen]', msg.msg);
    // Reenviar log a tabs activas si hay alguna en contexto
    return;
  }

  if (msg.type === 'START_DOWNLOAD') {
    const tabId = sender.tab?.id || msg.tabId;
    startDownload(tabId, msg.hlsUrl, msg.filename);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'POPUP_START_DOWNLOAD') {
    startDownload(msg.tabId, msg.hlsUrl, msg.filename);
    sendResponse({ ok: true });
    return true;
  }
});

console.log(`[SW] Vimeo Downloader v${VERSION} iniciado`);
