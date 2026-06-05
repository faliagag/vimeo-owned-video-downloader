function normalizeHost(v) {
  return (v || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}
function hostAllowed(pageUrl, allowedHost) {
  const current = new URL(pageUrl).hostname.toLowerCase();
  const normalized = normalizeHost(allowedHost);
  return normalized && (current === normalized || current.endsWith('.' + normalized) || current.endsWith(normalized));
}
function safeFilename(name) {
  return (name || 'video-vimeo').replace(/[\\/:\*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 160);
}
async function fetchText(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}
async function getConfigFromSources(videoId) {
  try {
    const html = await fetchText(`https://player.vimeo.com/video/${videoId}`);
    const dataConfigUrl = html.match(/data-config-url="([^"]+)"/i)?.[1];
    if (dataConfigUrl) return await fetchJson(dataConfigUrl.replace(/&amp;/g, '&'));
    const inlineConfig = html.match(/(?:window\.playerConfig\s*=\s*|var\s+config\s*=\s*)(\{[\s\S]*?\});/);
    if (inlineConfig?.[1]) return JSON.parse(inlineConfig[1]);
    const progressive = html.match(/"progressive"\s*:\s*(\[[\s\S]*?\])/);
    if (progressive?.[1]) return { request: { files: { progressive: JSON.parse(progressive[1]) } }, video: { title: `video-${videoId}` } };
  } catch (_) {}
  return await fetchJson(`https://player.vimeo.com/video/${videoId}/config`);
}
function candidateFilesFromConfig(config) {
  const candidates = [];
  const progressive = config?.request?.files?.progressive || config?.files?.progressive || [];
  if (Array.isArray(progressive)) {
    progressive.forEach(f => {
      if (f?.url) candidates.push({ source: 'progressive', quality: String(f.quality || f.rendition || f.height || 'best'), height: Number(f.height || 0), mime: f.mime || f.type || 'video/mp4', url: f.url, size: f.size || null, fps: f.fps || null });
    });
  }
  const download = config?.download || [];
  if (Array.isArray(download)) {
    download.forEach(f => {
      if (f?.link || f?.url) candidates.push({ source: 'download', quality: String(f.quality || f.rendition || f.height || 'best'), height: Number(f.height || 0), mime: f.type || 'video/mp4', url: f.link || f.url, size: f.size || null, fps: f.fps || null });
    });
  }
  const files = config?.request?.files || {};
  if (files?.dash?.cdns) Object.values(files.dash.cdns).forEach(cdn => cdn?.url && candidates.push({ source: 'dash-manifest', quality: 'manifest', height: 0, mime: 'application/dash+xml', url: cdn.url }));
  if (files?.hls?.cdns) Object.values(files.hls.cdns).forEach(cdn => cdn?.url && candidates.push({ source: 'hls-manifest', quality: 'manifest', height: 0, mime: 'application/x-mpegURL', url: cdn.url }));
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
async function processVideo(payload) {
  const { allowedHost } = await chrome.storage.local.get(['allowedHost']);
  if (!allowedHost) return { ok: false, message: 'Primero guarda el dominio permitido en el popup.' };
  if (!hostAllowed(payload.pageUrl, allowedHost)) return { ok: false, message: 'La página abierta no coincide con el dominio permitido.' };
  if (!payload.vimeoId) return { ok: false, message: 'No se pudo identificar el Vimeo ID.' };
  let config;
  try {
    config = await getConfigFromSources(payload.vimeoId);
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
      return { ok: true, message: `Descarga iniciada en ${chosen.quality || 'calidad detectada'}${chosen.size ? ` · ${Math.round(chosen.size / 1024 / 1024)} MB aprox.` : ''}` };
    } catch (e) {
      return { ok: false, message: `Chrome no inició la descarga: ${e.message}` };
    }
  }
  const manifests = candidates.filter(c => /hls|dash/.test(c.source));
  if (manifests.length) return { ok: false, message: 'Se detectó solo streaming HLS/DASH, no un archivo directo descargable.' };
  return { ok: false, message: 'No apareció ningún archivo directo utilizable desde el embed.' };
}
async function diagnose(videoId) {
  try {
    const config = await getConfigFromSources(videoId);
    const candidates = candidateFilesFromConfig(config);
    const direct = candidates.filter(c => /progressive|download/.test(c.source));
    const manifests = candidates.filter(c => /hls|dash/.test(c.source));
    return { ok: true, message: `Directos: ${direct.length} | Streaming: ${manifests.length} | Calidades: ${direct.map(d => d.quality).join(', ') || 'ninguna'}` };
  } catch (e) {
    return { ok: false, message: `Diagnóstico falló: ${e.message}` };
  }
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'TRY_DOWNLOAD') return sendResponse(await processVideo(msg.payload));
    if (msg?.type === 'DIAGNOSE_VIDEO') return sendResponse(await diagnose(msg.payload.vimeoId));
  })();
  return true;
});
