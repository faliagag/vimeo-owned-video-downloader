// background.js v10.0.0
// Service Worker principal.
// CAMBIO CLAVE v10: Ya no hace fetch directo a la API de Vimeo (causa 403).
// En su lugar, lee la config que el content_script captura del DOM de la pagina.

const VERSION = '10.0.0';
let offscreenReady = false;
let offscreenCreating = false;

function logSW(tabId, msg) {
  const ts = new Date().toLocaleTimeString('es-CL');
  console.log('[SW]', msg);
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'LOG', msg: `[${ts}] ${msg}` }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: 'CONVERT_PROGRESS', pct: -1, message: msg }).catch(() => {});
  }
}

async function ensureOffscreen() {
  if (offscreenReady) return;
  if (offscreenCreating) {
    await new Promise(r => setTimeout(r, 300));
    return ensureOffscreen();
  }
  offscreenCreating = true;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Concatenar segmentos HLS en archivo TS'
      });
    }
    offscreenReady = true;
  } catch (e) {
    console.error('[SW] Error creando offscreen:', e);
  } finally {
    offscreenCreating = false;
  }
}

function resolveUrl(base, relative) {
  try { return new URL(relative, base).href; } catch { return relative; }
}

async function execInTab(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: 'MAIN',
    func,
    args: args || []
  });
  return results?.[0]?.result;
}

// ── Leer config capturada por el interceptor en la pagina ────────────────
// El content_script inyecta codigo en world:MAIN que captura window.__vimeoConfigs__
// cuando Vimeo llama a su propio endpoint de config. Esto evita el 403.
async function getConfigFromPage(tabId, vimeoId) {
  try {
    const config = await execInTab(tabId, (vid) => {
      // Buscar en el interceptor del content_script
      if (window.__VIMEO_PAGE_CONFIGS__) {
        const key = String(vid);
        if (window.__VIMEO_PAGE_CONFIGS__[key]) {
          return window.__VIMEO_PAGE_CONFIGS__[key];
        }
        // Probar cualquier config disponible si hay solo una
        const keys = Object.keys(window.__VIMEO_PAGE_CONFIGS__);
        if (keys.length === 1) return window.__VIMEO_PAGE_CONFIGS__[keys[0]];
      }

      // Intentar leer config del DOM de la pagina player.vimeo.com
      try {
        const scriptEl = document.querySelector('script#player-config');
        if (scriptEl) return JSON.parse(scriptEl.textContent);
      } catch (e) {}

      // Intentar leer del objeto global window.Vimeo o similares
      if (window.__player_config) return window.__player_config;
      if (window.playerConfig) return window.playerConfig;

      return null;
    }, [String(vimeoId)]);
    return config || null;
  } catch (e) {
    console.warn('[SW] getConfigFromPage error:', e.message);
    return null;
  }
}

// ── Scan de embeds en la tab activa ─────────────────────────────────────
async function getEmbedsFromTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['page_scanner.js'],
      world: 'MAIN'
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 400));

    const embeds = await execInTab(tabId, () => {
      if (typeof window.__scanVimeoEmbedsNow === 'function') {
        return window.__scanVimeoEmbedsNow();
      }
      const results = [];
      document.querySelectorAll('iframe').forEach(iframe => {
        const src = iframe.src || iframe.getAttribute('data-src') || '';
        const m = src.match(/player\.vimeo\.com\/video\/(\d+)/);
        if (m) results.push({ vimeoId: m[1], src, hasConfig: false, config: null, strategy: 'dom' });
      });
      return results;
    });

    return Array.isArray(embeds) ? embeds : [];
  } catch (e) {
    console.error('[SW] getEmbedsFromTab error:', e);
    return [];
  }
}

// ── Descarga de segmentos HLS (con Referer correcto) ─────────────────────
async function fetchSegment(url, pageUrl) {
  const resp = await fetch(url, {
    headers: {
      'Referer': pageUrl || 'https://player.vimeo.com/',
      'Origin': 'https://player.vimeo.com'
    }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.arrayBuffer();
}

async function downloadHLS(tabId, masterUrl, pageUrl) {
  logSW(tabId, 'Obteniendo M3U8 maestro...');
  const headers = {
    'Referer': pageUrl || 'https://player.vimeo.com/',
    'Origin': 'https://player.vimeo.com'
  };

  const masterResp = await fetch(masterUrl, { headers });
  if (!masterResp.ok) throw new Error(`M3U8 HTTP ${masterResp.status}`);
  const masterText = await masterResp.text();
  const lines = masterText.split('\n').map(l => l.trim()).filter(Boolean);

  let playlistUrl = null;
  let bestBandwidth = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwM = lines[i].match(/BANDWIDTH=(\d+)/);
      const bw = bwM ? parseInt(bwM[1]) : 0;
      if (bw >= bestBandwidth && i + 1 < lines.length && !lines[i+1].startsWith('#')) {
        bestBandwidth = bw;
        playlistUrl = resolveUrl(masterUrl, lines[i+1]);
      }
    }
  }
  if (!playlistUrl) playlistUrl = masterUrl;

  logSW(tabId, `Playlist: ${playlistUrl}`);
  const plResp = await fetch(playlistUrl, { headers });
  if (!plResp.ok) throw new Error(`Playlist HTTP ${plResp.status}`);
  const plText = await plResp.text();
  const segLines = plText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  if (!segLines.length) throw new Error('Sin segmentos en M3U8');
  logSW(tabId, `${segLines.length} segmentos encontrados`);

  const segments = [];
  for (let i = 0; i < segLines.length; i++) {
    const pct = Math.round(((i + 1) / segLines.length) * 80);
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'CONVERT_PROGRESS',
        pct,
        message: `Descargando segmento ${i+1}/${segLines.length}…`
      }).catch(() => {});
    }
    const segUrl = resolveUrl(playlistUrl, segLines[i]);
    segments.push(await fetchSegment(segUrl, pageUrl));
  }
  return segments;
}

async function startHLSDownload(tabId, hlsUrl, filename, pageUrl) {
  try {
    logSW(tabId, `v${VERSION} — Iniciando descarga HLS`);
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'CONVERT_PROGRESS', pct: 0, message: 'Preparando descarga…' }).catch(() => {});

    await ensureOffscreen();

    const segments = await downloadHLS(tabId, hlsUrl, pageUrl);
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'CONVERT_PROGRESS', pct: 85, message: 'Concatenando segmentos…' }).catch(() => {});

    logSW(tabId, `Enviando ${segments.length} segmentos al offscreen`);
    const result = await chrome.runtime.sendMessage({
      type: 'CONVERT_TS_TO_MP4',
      segments,
      filename: filename || 'video-vimeo'
    });

    if (!result?.ok) throw new Error(result?.error || 'Error en offscreen');

    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'CONVERT_PROGRESS', pct: 95, message: 'Iniciando descarga del archivo…' }).catch(() => {});

    await chrome.downloads.download({
      url: result.dataUrl,
      filename: result.filename,
      saveAs: false
    });

    logSW(tabId, `✅ Descarga completa: ${result.filename} (${(result.bytes/1024/1024).toFixed(1)} MB)`);
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'CONVERT_PROGRESS', pct: 100, message: `✅ Listo: ${result.filename}` }).catch(() => {});
    return { ok: true, message: `Descargado: ${result.filename}` };

  } catch (e) {
    logSW(tabId, `❌ Error: ${e.message}`);
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'CONVERT_PROGRESS', pct: -1, message: `❌ ${e.message}` }).catch(() => {});
    return { ok: false, message: e.message };
  }
}

// ── Flujo principal de descarga ──────────────────────────────────────────
async function tryDownload({ vimeoId, tabId, pageUrl, preferredName }) {
  logSW(tabId, `TRY_DOWNLOAD: ID ${vimeoId}`);

  // PASO 1: Leer config del interceptor en la pagina (NO fetch a la API — evita 403)
  let config = await getConfigFromPage(tabId, vimeoId);

  if (!config) {
    // PASO 2: Si estamos en player.vimeo.com, esperar y reintentar
    logSW(tabId, 'Config no disponible aun, esperando 2s y reintentando...');
    await new Promise(r => setTimeout(r, 2000));
    config = await getConfigFromPage(tabId, vimeoId);
  }

  if (!config) {
    return {
      ok: false,
      message: 'No se pudo obtener la configuracion del video.\n\n' +
               '➡️ Asegurate de que el video este reproduciendose en la pagina y vuelve a intentarlo.'
    };
  }

  // PASO 3: Buscar MP4 progresivo (mejor opcion)
  const progressive = config?.request?.files?.progressive || config?.files?.progressive || [];
  if (progressive.length) {
    progressive.sort((a, b) => (b.height || 0) - (a.height || 0));
    const best = progressive[0];
    logSW(tabId, `MP4 directo: ${best.quality || best.height}p`);
    const fname = (preferredName || `vimeo-${vimeoId}`) + '.mp4';
    await chrome.downloads.download({ url: best.url, filename: fname, saveAs: false });
    return { ok: true, message: `Descargando MP4 ${best.quality || best.height}p` };
  }

  // PASO 4: Buscar enlaces de descarga directa
  const downloads = config?.download || config?.request?.files?.download || [];
  if (downloads.length) {
    downloads.sort((a, b) => (b.height || 0) - (a.height || 0));
    const best = downloads[0];
    const url = best.link || best.url;
    logSW(tabId, `Descarga directa: ${best.quality || best.height}p`);
    const fname = (preferredName || `vimeo-${vimeoId}`) + '.mp4';
    await chrome.downloads.download({ url, filename: fname, saveAs: false });
    return { ok: true, message: `Descargando MP4 directo ${best.quality || best.height}p` };
  }

  // PASO 5: HLS como ultimo recurso
  const hlsCdns = config?.request?.files?.hls?.cdns || config?.files?.hls?.cdns || {};
  const cdnEntries = Object.values(hlsCdns);
  const hlsUrl = cdnEntries[0]?.url || config?.request?.files?.hls?.url || config?.files?.hls?.url;

  if (hlsUrl) {
    const title = config?.video?.title || preferredName || `vimeo-${vimeoId}`;
    logSW(tabId, `HLS encontrado, iniciando conversion: ${hlsUrl}`);
    return { converting: true, hlsUrl, title };
  }

  return { ok: false, message: 'No se encontraron archivos descargables en la configuracion del video.' };
}

// ── Message handlers ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'OFFSCREEN_LOG') {
    console.log('[Offscreen]', msg.msg);
    return;
  }

  if (msg.type === 'GET_EMBEDS') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return sendResponse({ ok: false, message: 'No hay tab activa.' });
        const embeds = await getEmbedsFromTab(tab.id);
        sendResponse({ ok: true, embeds, tabId: tab.id, pageUrl: tab.url });
      } catch (e) {
        sendResponse({ ok: false, message: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'DEBUG_IFRAMES') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return sendResponse({ iframes: [] });
        const iframes = await execInTab(tab.id, () => {
          return Array.from(document.querySelectorAll('iframe')).map(f => ({
            src: f.src, dataSrc: f.getAttribute('data-src'),
            id: f.id, className: f.className
          }));
        });
        sendResponse({ iframes: iframes || [] });
      } catch (e) { sendResponse({ iframes: [], error: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'INJECT_FLOATER') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['floater.js'] }).catch(() => {});
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['floater.css'] }).catch(() => {});
        }
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false }); }
    })();
    return true;
  }

  if (msg.type === 'TRY_DOWNLOAD') {
    (async () => {
      try {
        const result = await tryDownload(msg.payload);
        sendResponse(result);
      } catch (e) { sendResponse({ ok: false, message: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'CONVERT_HLS') {
    const { hlsUrl, title, referer, tabId, videoId } = msg.payload || {};
    startHLSDownload(tabId, hlsUrl, title, referer).then(sendResponse).catch(e => sendResponse({ ok: false, message: e.message }));
    return true;
  }

  if (msg.type === 'DIAGNOSE_VIDEO') {
    (async () => {
      const { vimeoId, tabId, pageUrl } = msg.payload || {};
      try {
        const config = await getConfigFromPage(tabId, vimeoId);
        if (!config) return sendResponse({ message: `ID: ${vimeoId} | Config no disponible en pagina. Asegurate de reproducir el video primero.` });
        const prog = config?.request?.files?.progressive || [];
        const hls = config?.request?.files?.hls?.cdns || {};
        const dl = config?.download || [];
        sendResponse({
          message: `ID: ${vimeoId} | MP4: ${prog.length} | HLS CDNs: ${Object.keys(hls).length} | Downloads: ${dl.length} | Titulo: ${config?.video?.title || 'N/A'}`
        });
      } catch (e) {
        sendResponse({ message: `Error: ${e.message}` });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_RAW_CONFIG') {
    (async () => {
      const { tabId, vimeoId } = msg.payload || {};
      try {
        const config = await getConfigFromPage(tabId, vimeoId);
        if (!config) return sendResponse({ ok: false, message: 'Config no disponible. Reproduce el video primero.' });

        const files = config?.request?.files || config?.files || {};
        const prog = files?.progressive || [];
        const hls = files?.hls?.cdns || {};
        const dl = config?.download || [];

        const candidates = [
          ...prog.map(f => ({ source: 'MP4', quality: `${f.quality||f.height}p`, size: f.size||0 })),
          ...dl.map(f => ({ source: 'DL', quality: `${f.quality||f.height}p`, size: f.size||0 })),
          ...Object.keys(hls).map(k => ({ source: 'HLS', quality: k, size: 0 }))
        ];

        sendResponse({
          ok: true,
          source: 'page-interceptor',
          filesKeys: Object.keys(files),
          videoTitle: config?.video?.title || '',
          candidates
        });
      } catch (e) { sendResponse({ ok: false, message: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'POPUP_START_DOWNLOAD') {
    startHLSDownload(msg.tabId, msg.hlsUrl, msg.filename, msg.pageUrl)
      .then(sendResponse).catch(e => sendResponse({ ok: false, message: e.message }));
    return true;
  }
});

console.log(`[SW] Vimeo Downloader v${VERSION} iniciado`);
