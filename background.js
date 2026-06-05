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

/* ===== FIX 403: fetch config desde contexto de página =====
 * El service worker NO adjunta el Referer del sitio al llamar a player.vimeo.com.
 * Solución: se inyecta una función en el contexto MAIN de la página (a través de
 * scripting.executeScript con world:'MAIN'), que sí envía el Referer correcto.
 * La respuesta vuelve al service worker vía promesa.
 */
async function fetchVimeoConfigFromPage(tabId, videoId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (vid) => {
      // Esta función corre en el contexto de la página: Referer = dominio del sitio
      if (typeof window.__vimeoFetchConfig === 'function') {
        return await window.__vimeoFetchConfig(vid);
      }
      // Fallback inline si content.js aún no inyectó __vimeoFetchConfig
      async function tryFetch(url, opts) {
        const r = await fetch(url, opts);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r;
      }
      try {
        const html = await (await tryFetch(`https://player.vimeo.com/video/${vid}`, { credentials: 'include' })).text();
        const dcUrl = (html.match(/data-config-url="([^"]+)"/i) || [])[1];
        if (dcUrl) {
          const cfg = await (await tryFetch(dcUrl.replace(/&amp;/g, '&'), { credentials: 'include' })).json();
          return { ok: true, config: cfg };
        }
        const inlineMatch = html.match(/(?:window\.playerConfig\s*=\s*|var\s+config\s*=\s*)(\{[\s\S]{10,5000}?\});/);
        if (inlineMatch) { try { return { ok: true, config: JSON.parse(inlineMatch[1]) }; } catch(_) {} }
        const progMatch = html.match(/"progressive"\s*:\s*(\[[\s\S]{2,4000}?\])/);
        if (progMatch) { try { return { ok: true, config: { request: { files: { progressive: JSON.parse(progMatch[1]) } }, video: { title: 'video-' + vid } } }; } catch(_) {} }
      } catch(_) {}
      try {
        const cfg = await (await tryFetch(`https://player.vimeo.com/video/${vid}/config`, { credentials: 'include' })).json();
        return { ok: true, config: cfg };
      } catch(e) {
        return { ok: false, error: e.message };
      }
    },
    args: [videoId]
  });
  const result = results?.[0]?.result;
  if (!result) throw new Error('No se obtuvo respuesta del contexto de página');
  if (!result.ok) throw new Error(result.error || 'Error desconocido');
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
  if (files?.dash?.cdns) Object.values(files.dash.cdns).forEach(cdn =>
    cdn?.url && candidates.push({ source: 'dash-manifest', quality: 'manifest', height: 0, mime: 'application/dash+xml', url: cdn.url })
  );
  if (files?.hls?.cdns) Object.values(files.hls.cdns).forEach(cdn =>
    cdn?.url && candidates.push({ source: 'hls-manifest', quality: 'manifest', height: 0, mime: 'application/x-mpegURL', url: cdn.url })
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

/* ===== OBTENER TAB ACTIVA ===== */
async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
}

/* ===== PROCESAR VIDEO ===== */
async function processVideo(payload) {
  const { allowedHost } = await chrome.storage.local.get(['allowedHost']);
  if (!allowedHost) return { ok: false, message: 'Primero guarda el dominio permitido en el popup.' };
  if (!hostAllowed(payload.pageUrl, allowedHost)) return { ok: false, message: 'La página abierta no coincide con el dominio permitido.' };
  if (!payload.vimeoId) return { ok: false, message: 'No se pudo identificar el Vimeo ID.' };

  const tabId = payload.tabId || await getActiveTabId();
  if (!tabId) return { ok: false, message: 'No se encontró la pestaña activa.' };

  let config;
  try {
    // FIX: fetch desde contexto de página (envía Referer correcto a Vimeo)
    config = await fetchVimeoConfigFromPage(tabId, payload.vimeoId);
  } catch (e) {
    return { ok: false, message: `No se pudo leer la configuración del player: ${e.message}` };
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
        message: `Descarga iniciada · ${chosen.quality || 'calidad detectada'}${
          chosen.size ? ` · ${Math.round(chosen.size / 1024 / 1024)} MB aprox.` : ''
        }`
      };
    } catch (e) {
      return { ok: false, message: `Chrome no inició la descarga: ${e.message}` };
    }
  }
  const manifests = candidates.filter(c => /hls|dash/.test(c.source));
  if (manifests.length) return { ok: false, message: 'Solo streaming HLS/DASH detectado. No hay archivo directo descargable en este video.' };
  return { ok: false, message: 'No apareció ningún archivo directo utilizable desde el embed.' };
}

/* ===== DIAGNÓSTICO ===== */
async function diagnose(payload) {
  const tabId = payload.tabId || await getActiveTabId();
  if (!tabId) return { ok: false, message: 'No se encontró la pestaña activa.' };
  if (!payload.vimeoId) return { ok: false, message: 'Sin Vimeo ID para diagnosticar.' };
  try {
    const config = await fetchVimeoConfigFromPage(tabId, payload.vimeoId);
    const candidates = candidateFilesFromConfig(config);
    const direct = candidates.filter(c => /progressive|download/.test(c.source));
    const manifests = candidates.filter(c => /hls|dash/.test(c.source));
    return {
      ok: true,
      message: `Directos: ${direct.length} | Streaming: ${manifests.length} | Calidades: ${direct.map(d => d.quality).join(', ') || 'ninguna'}`
    };
  } catch (e) {
    return { ok: false, message: `Diagnóstico falló: ${e.message}` };
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
