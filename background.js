/* ===== UTILIDADES ===== */
function normalizeHost(v) {
  return (v || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}
function hostAllowed(pageUrl, allowedHost) {
  try {
    const current = new URL(pageUrl).hostname.toLowerCase();
    const normalized = normalizeHost(allowedHost);
    return normalized && (current === normalized || current.endsWith('.' + normalized));
  } catch { return false; }
}
function safeFilename(name) {
  return (name || 'video-vimeo').replace(/[\\/:\*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/* ===== OBTENER CONFIG DESDE EL IFRAME (sin fetch externo) =====
 * La arquitectura real:
 * 1. vimeo_frame.js corre en world:MAIN dentro del iframe player.vimeo.com
 * 2. Lee window.playerConfig que Vimeo ya cargó
 * 3. Lo manda al padre via postMessage
 * 4. content.js lo guarda en window.__vimeoConfigs[videoId]
 * 5. background.js lo obtiene via scripting.executeScript llamando a __getVimeoConfig()
 * RESULTADO: cero fetch externos → sin CORS → sin 403
 */
async function getVimeoConfigViaFrame(tabId, videoId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (vid) => {
      if (typeof window.__getVimeoConfig === 'function') {
        return await window.__getVimeoConfig(vid);
      }
      return { config: null, error: '__getVimeoConfig no está disponible. Recarga la página.' };
    },
    args: [videoId]
  });
  const result = results?.[0]?.result;
  if (!result) throw new Error('No se obtuvo respuesta de content.js');
  if (!result.config) throw new Error(result.error || 'playerConfig no disponible en el iframe de Vimeo');
  return result.config;
}

/* ===== PARSEAR ARCHIVOS DEL CONFIG ===== */
function candidateFilesFromConfig(config) {
  const candidates = [];
  const progressive = config?.request?.files?.progressive || config?.files?.progressive || [];
  if (Array.isArray(progressive)) {
    progressive.forEach(f => {
      if (f?.url) candidates.push({
        source: 'progressive',
        quality: String(f.quality || f.rendition || f.height || 'best'),
        height: Number(f.height || 0),
        mime: f.mime || f.type || 'video/mp4',
        url: f.url, size: f.size || null, fps: f.fps || null
      });
    });
  }
  const download = config?.download || [];
  if (Array.isArray(download)) {
    download.forEach(f => {
      if (f?.link || f?.url) candidates.push({
        source: 'download',
        quality: String(f.quality || f.rendition || f.height || 'best'),
        height: Number(f.height || 0),
        mime: f.type || 'video/mp4',
        url: f.link || f.url, size: f.size || null, fps: f.fps || null
      });
    });
  }
  const files = config?.request?.files || {};
  if (files?.hls?.cdns) Object.values(files.hls.cdns).forEach(cdn =>
    cdn?.url && candidates.push({ source: 'hls-manifest', quality: 'manifest', height: 0, mime: 'application/x-mpegURL', url: cdn.url })
  );
  if (files?.dash?.cdns) Object.values(files.dash.cdns).forEach(cdn =>
    cdn?.url && candidates.push({ source: 'dash-manifest', quality: 'manifest', height: 0, mime: 'application/dash+xml', url: cdn.url })
  );
  return candidates;
}

function pickCandidate(candidates, preferredQuality) {
  const direct = candidates.filter(c => /mp4|webm|video\//i.test(c.mime) || /progressive|download/.test(c.source));
  if (!direct.length) return null;
  if (!preferredQuality || preferredQuality === 'best') return direct.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  const target = Number(preferredQuality);
  const exact = direct.filter(c => Number(c.height) === target).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (exact) return exact;
  const lower = direct.filter(c => Number(c.height) <= target).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (lower) return lower;
  return direct.sort((a, b) => (a.height || 99999) - (b.height || 99999))[0];
}

async function startDownload(url, filename) {
  await chrome.downloads.download({ url, filename, saveAs: true, conflictAction: 'uniquify' });
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
}

/* ===== PROCESAR DESCARGA ===== */
async function processVideo(payload) {
  const { allowedHost } = await chrome.storage.local.get(['allowedHost']);
  if (!allowedHost) return { ok: false, message: 'Primero guarda el dominio permitido en el popup.' };
  if (!hostAllowed(payload.pageUrl, allowedHost)) return { ok: false, message: 'La página abierta no coincide con el dominio permitido.' };
  if (!payload.vimeoId) return { ok: false, message: 'No se pudo identificar el Vimeo ID.' };

  const tabId = payload.tabId || await getActiveTabId();
  if (!tabId) return { ok: false, message: 'No se encontró la pestaña activa.' };

  let config;
  try {
    config = await getVimeoConfigViaFrame(tabId, payload.vimeoId);
  } catch (e) {
    return { ok: false, message: `❌ ${e.message}` };
  }

  const candidates = candidateFilesFromConfig(config);
  const chosen = pickCandidate(candidates, payload.preferredQuality);
  const title = safeFilename(payload.preferredName || config?.video?.title || payload.titleHint || `video-${payload.vimeoId}`);

  if (chosen?.url) {
    const ext = /webm/i.test(chosen.mime || '') ? 'webm' : 'mp4';
    try {
      await startDownload(chosen.url, `${title}.${ext}`);
      return {
        ok: true,
        message: `✅ Descarga iniciada · ${chosen.quality || 'mejor calidad'}${
          chosen.size ? ` · ${Math.round(chosen.size / 1024 / 1024)} MB aprox.` : ''
        }`
      };
    } catch (e) {
      return { ok: false, message: `Chrome no inició la descarga: ${e.message}` };
    }
  }

  const manifests = candidates.filter(c => /hls|dash/.test(c.source));
  if (manifests.length) return { ok: false, message: '⚠️ Solo streaming HLS/DASH disponible. No hay MP4 directo descargable en este video.' };
  return { ok: false, message: '❌ No se encontró archivo descargable. El video puede ser solo-streaming en Vimeo.' };
}

/* ===== DIAGNÓSTICO ===== */
async function diagnose(payload) {
  const tabId = payload.tabId || await getActiveTabId();
  if (!tabId) return { ok: false, message: 'No se encontró la pestaña activa.' };
  if (!payload.vimeoId) return { ok: false, message: 'Sin Vimeo ID para diagnosticar.' };
  try {
    const config = await getVimeoConfigViaFrame(tabId, payload.vimeoId);
    const candidates = candidateFilesFromConfig(config);
    const direct = candidates.filter(c => /progressive|download/.test(c.source));
    const manifests = candidates.filter(c => /hls|dash/.test(c.source));
    const title = config?.video?.title || '(sin título)';
    return {
      ok: true,
      message: `✅ Config leída · "${title}" · MP4 directos: ${direct.length} · Streaming: ${manifests.length} · Calidades: ${direct.map(d => d.quality + (d.height ? 'p' : '')).join(', ') || 'ninguna'}`
    };
  } catch (e) {
    return { ok: false, message: `❌ Diagnóstico falló: ${e.message}` };
  }
}

/* ===== LISTENERS ===== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'TRY_DOWNLOAD') return sendResponse(await processVideo(msg.payload));
    if (msg?.type === 'DIAGNOSE_VIDEO') return sendResponse(await diagnose(msg.payload));
  })();
  return true;
});
