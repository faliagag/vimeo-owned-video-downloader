/* background.js v9.8
 *
 * Estrategias de obtención del playerConfig (en orden):
 *  1. playerConfig desde iframe ya cargado en la página (world:MAIN)
 *  2. postMessage interceptado por vimeo_interceptor.js
 *  3. config.js público sin autenticación
 *  4. config.js CON cookies de sesión de Vimeo (credentials:include)
 *  5. Abrir player.vimeo.com en tab oculta y extraer config
 *  6. oEmbed (solo metadata)
 *
 * Descarga:
 *  A. MP4 progresivo directo (chrome.downloads)
 *  B. HLS → segmentos → Offscreen Document (ffmpeg.wasm) → .mp4
 *
 * v9.8: arquitectura Offscreen Document
 *  - Sin tabs visibles para la conversión
 *  - ffmpeg.wasm carga UNA vez y se reutiliza
 *  - Sin timeouts frágiles de tab
 */
'use strict';

const CHUNK_SIZE = 4 * 1024 * 1024;

// ── Utils ─────────────────────────────────────────────────────────────────────
function safeFilename(n) {
  return (n || 'video-vimeo')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}
function normalizeHost(v) {
  return (v || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}
function hostAllowed(pageUrl, allowedHost) {
  if (!allowedHost) return false;
  try {
    const h = new URL(pageUrl).hostname.toLowerCase();
    const a = normalizeHost(allowedHost);
    return !!a && (h === a || h.endsWith('.' + a));
  } catch (_) { return false; }
}
async function runInPage(tabId, fn, args) {
  const r = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func: fn, args: args || []
  });
  return r?.[0]?.result;
}
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}
function sendProgress(msg, pct, tabId, videoId, title) {
  const data = { type: 'CONVERT_PROGRESS', message: msg, pct: pct ?? -1,
                 __videoId: String(videoId || ''), __title: title || '' };
  chrome.runtime.sendMessage(data).catch(() => {});
  if (tabId) chrome.tabs.sendMessage(tabId, data).catch(() => {});
}
async function ensureScripts(tabId) {
  try {
    await chrome.scripting.executeScript({ target:{tabId}, files:['page_scanner.js'], world:'MAIN' });
    await chrome.scripting.executeScript({ target:{tabId}, files:['vimeo_frame.js'],  world:'MAIN' });
  } catch(e) { console.warn('[VD] ensureScripts:', e.message); }
}
async function ensureFloater(tabId) {
  try {
    await chrome.scripting.insertCSS({ target:{tabId}, files:['floater.css'] }).catch(()=>{});
    await chrome.scripting.executeScript({ target:{tabId}, files:['floater.js'] });
  } catch(e) { console.warn('[VD] ensureFloater:', e.message); }
}

// ── Offscreen Document ────────────────────────────────────────────────────────
let offscreenCreating = false;
let offscreenReady    = false;

async function ensureOffscreen() {
  // Verificar si ya existe
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;

  if (offscreenCreating) {
    // Esperar a que termine la creación en curso
    await new Promise(r => setTimeout(r, 500));
    return;
  }

  offscreenCreating = true;
  try {
    await chrome.offscreen.createDocument({
      url:    chrome.runtime.getURL('offscreen.html'),
      reasons: ['WORKERS'],
      justification: 'Cargar ffmpeg.wasm para convertir segmentos HLS a MP4'
    });
  } catch(e) {
    // Puede fallar si ya existe (race condition)
    console.warn('[VD] createDocument:', e.message);
  } finally {
    offscreenCreating = false;
  }
}

/**
 * Espera a que offscreen.js emita OFFSCREEN_READY.
 * Si ya está listo (flag offscreenReady), resuelve inmediatamente.
 * Timeout 120 s para la carga inicial de WASM desde CDN.
 */
async function waitOffscreenReady(ms = 120_000) {
  if (offscreenReady) return;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(l);
      reject(new Error('Timeout cargando ffmpeg.wasm (' + Math.round(ms/1000) + 's). Verifica tu conexión a internet.'));
    }, ms);
    function l(msg) {
      if (msg?.type === 'OFFSCREEN_READY') {
        clearTimeout(t);
        chrome.runtime.onMessage.removeListener(l);
        offscreenReady = msg.ok !== false;
        resolve();
      }
    }
    chrome.runtime.onMessage.addListener(l);
  });
}

// Escuchar OFFSCREEN_READY de forma global para cachear el estado
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'OFFSCREEN_READY') {
    offscreenReady = msg.ok !== false;
    console.log('[VD] Offscreen READY, ok =', offscreenReady);
  }
});

// ── Obtener embeds ────────────────────────────────────────────────────────────
async function getEmbeds(tabId) {
  await ensureScripts(tabId);
  await new Promise(r => setTimeout(r, 700));
  return runInPage(tabId, () =>
    typeof window.__scanVimeoEmbedsNow === 'function'
      ? window.__scanVimeoEmbedsNow()
      : (window.__VIMEO_EMBEDS__ || [])
  );
}

// ── Estrategia 1+2: playerConfig desde página ─────────────────────────────────
async function getPlayerConfigFromPage(tabId, videoId) {
  return runInPage(tabId, (vid) =>
    typeof window.__getVimeoConfig === 'function'
      ? window.__getVimeoConfig(vid)
      : { config: null, error: 'scanner no cargado' }
  , [String(videoId)]);
}

// ── Estrategia 3: config.js sin auth ──────────────────────────────────────────
async function fetchConfigJs(videoId, referer) {
  const urls = [
    `https://player.vimeo.com/video/${videoId}/config`,
    `https://player.vimeo.com/video/${videoId}/config?autopause=1&autoplay=0`,
  ];
  const headers = { 'Referer': referer || 'https://vimeo.com/' };
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, credentials: 'omit' });
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.request?.files) return json;
    } catch(_) {}
  }
  return null;
}

// ── Estrategia 4: config.js CON cookies ───────────────────────────────────────
async function fetchConfigJsWithCookies(videoId, referer) {
  const urls = [
    `https://player.vimeo.com/video/${videoId}/config`,
    `https://player.vimeo.com/video/${videoId}/config?autopause=1&autoplay=0&loop=0`,
  ];
  const ref = referer || 'https://vimeo.com/';
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'Referer': ref, 'Origin': new URL(ref).origin },
        credentials: 'include', mode: 'cors'
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.request?.files) return json;
    } catch(_) {}
  }
  return null;
}

// ── Estrategia 5: tab oculta ──────────────────────────────────────────────────
async function fetchConfigViaHiddenTab(videoId, pageUrl) {
  return new Promise(async (resolve) => {
    const playerUrl = `https://player.vimeo.com/video/${videoId}?autoplay=0&dnt=1`;
    let tabId;
    try { const tab = await chrome.tabs.create({ url: playerUrl, active: false }); tabId = tab.id; }
    catch(e) { return resolve(null); }
    const cleanup = () => chrome.tabs.remove(tabId).catch(() => {});
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 12000);
    const msgListener = (msg) => {
      if (msg?.__vimeoExtConfig && String(msg.videoId) === String(videoId)) {
        clearTimeout(timeout); chrome.runtime.onMessage.removeListener(msgListener); cleanup(); resolve(msg.config);
      }
    };
    chrome.runtime.onMessage.addListener(msgListener);
    chrome.tabs.onUpdated.addListener(async function listener(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      await new Promise(r => setTimeout(r, 1000));
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: () => {
            for (const k of ['playerConfig','__playerConfig','config']) {
              try { const v = window[k]; if (v?.request?.files && v?.video?.id) return v; } catch(_){}
            }
            for (const k of Object.keys(window)) {
              try { const v = window[k]; if (v?.request?.files && v?.video?.id) return v; } catch(_){}
            }
            return null;
          }
        });
        const cfg = result?.[0]?.result;
        if (cfg) { clearTimeout(timeout); chrome.runtime.onMessage.removeListener(msgListener); cleanup(); resolve(cfg); }
      } catch(_) {}
    });
  });
}

// ── Estrategia 6: oEmbed ──────────────────────────────────────────────────────
async function fetchOEmbed(videoId) {
  try {
    const res = await fetch(`https://vimeo.com/api/oembed.json?url=https://vimeo.com/${videoId}&width=1920`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.title && !data?.html) return null;
    return data;
  } catch(_) { return null; }
}

// ── Parsear candidatos ────────────────────────────────────────────────────────
function parseCandidates(config) {
  const out = [], seen = new Set();
  function add(c) { if (c?.url && !seen.has(c.url)) { seen.add(c.url); out.push(c); } }
  const prog = config?.request?.files?.progressive || config?.files?.progressive || [];
  if (Array.isArray(prog))
    prog.forEach(f => { if (f?.url) add({ source:'progressive', quality:String(f.quality||f.height||'sd'), height:Number(f.height||0), mime:'video/mp4', url:f.url, size:f.size||null }); });
  const dl = config?.download || config?.request?.files?.download || [];
  if (Array.isArray(dl))
    dl.forEach(f => { const u=f?.link||f?.url; if(u) add({ source:'download', quality:String(f.quality||f.height||'sd'), height:Number(f.height||0), mime:'video/mp4', url:u, size:f.size||null }); });
  const hlsCdns = config?.request?.files?.hls?.cdns || config?.files?.hls?.cdns || {};
  Object.values(hlsCdns).forEach(c => { if(c?.url) add({ source:'hls', quality:'hls', height:0, mime:'application/x-mpegURL', url:c.url }); });
  const hlsUrl = config?.request?.files?.hls?.url || config?.files?.hls?.url;
  if (hlsUrl) add({ source:'hls', quality:'hls', height:0, mime:'application/x-mpegURL', url:hlsUrl });
  function deepMp4(obj, d) {
    if (!obj || d > 6) return;
    if (typeof obj === 'string') { if (/\.mp4/i.test(obj) && /^https?:\/\//.test(obj)) add({ source:'deep', quality:'unknown', height:0, mime:'video/mp4', url:obj }); return; }
    if (Array.isArray(obj)) { obj.forEach(i => deepMp4(i,d+1)); return; }
    if (typeof obj === 'object') Object.values(obj).forEach(v => deepMp4(v,d+1));
  }
  deepMp4(config, 0);
  return out;
}
function pickBestDirect(c) {
  return c.filter(x => /progressive|download|deep/.test(x.source)).sort((a,b) => (b.height||0)-(a.height||0))[0] || null;
}
function pickBestHls(c) { return c.find(x => x.source==='hls') || null; }

// ── HLS downloader ────────────────────────────────────────────────────────────
async function resolveM3u8(url, referer) {
  const h = referer ? { 'Referer': referer } : {};
  const res = await fetch(url, { headers:h });
  if (!res.ok) throw new Error('Manifiesto HTTP '+res.status);
  const text = await res.text();
  if (!text.includes('#EXT-X-STREAM-INF')) return { url, text };
  const lines = text.split('\n'), variants = [];
  for (let i=0;i<lines.length;i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwM=lines[i].match(/BANDWIDTH=(\d+)/), uri=(lines[i+1]||'').trim();
      if (uri && !uri.startsWith('#')) variants.push({ bw:bwM?parseInt(bwM[1]):0, uri });
    }
  }
  if (!variants.length) throw new Error('Sin variantes.');
  variants.sort((a,b)=>b.bw-a.bw);
  const best = variants[0].uri.startsWith('http') ? variants[0].uri : new URL(variants[0].uri,url).href;
  const res2 = await fetch(best, { headers:h });
  if (!res2.ok) throw new Error('Variante HTTP '+res2.status);
  return { url:best, text:await res2.text() };
}
async function downloadAllSegments(manifestUrl, manifestText, referer, tabId, videoId, title) {
  const h = referer ? { 'Referer':referer } : {};
  const lines = manifestText.split('\n').map(l=>l.trim());
  const segs  = lines.filter(l=>l && !l.startsWith('#'));
  if (!segs.length) throw new Error('Sin segmentos.');
  const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/')+1);
  const buffers = []; let totalBytes=0;
  for (let j=0;j<segs.length;j++) {
    const segUrl = segs[j].startsWith('http') ? segs[j] : base+segs[j];
    if (j%5===0||j===segs.length-1)
      sendProgress('Segmento '+(j+1)+'/'+segs.length, Math.round((j/segs.length)*40)+5, tabId, videoId, title);
    let attempts=4;
    while (attempts-->0) {
      try {
        const r=await fetch(segUrl,{headers:h}); if(!r.ok) throw new Error('HTTP '+r.status);
        const buf=await r.arrayBuffer(); buffers.push(buf); totalBytes+=buf.byteLength; break;
      } catch(e) { if(attempts===0) throw new Error('Seg '+(j+1)+': '+e.message); await new Promise(r=>setTimeout(r,1000)); }
    }
  }
  sendProgress('Ensamblando '+Math.round(totalBytes/1024/1024)+' MB…', 46, tabId, videoId, title);
  const merged=new Uint8Array(totalBytes); let offset=0;
  for (const buf of buffers) { merged.set(new Uint8Array(buf),offset); offset+=buf.byteLength; }
  return merged;
}

// ── Conversión via Offscreen Document ────────────────────────────────────────
async function convertWithOffscreen(tsData, filename, tabId, videoId, title) {
  // Asegurar que el documento offscreen existe
  sendProgress('Preparando conversor…', 47, tabId, videoId, title);
  await ensureOffscreen();

  // Si WASM no está listo aún, esperar (120 s max)
  if (!offscreenReady) {
    sendProgress('Cargando ffmpeg.wasm (primera vez ~30s)…', 48, tabId, videoId, title);
    await waitOffscreenReady(120_000);
  }

  sendProgress('Convirtiendo TS→MP4…', 50, tabId, videoId, title);

  return new Promise((resolve, reject) => {
    // Escuchar respuesta del offscreen
    const handler = (msg) => {
      if (msg?.type === 'OFFSCREEN_PROGRESS') {
        sendProgress(msg.msg, msg.pct, tabId, videoId, title);
        return;
      }
      if (msg?.type === 'OFFSCREEN_DONE') {
        chrome.runtime.onMessage.removeListener(handler);
        resolve({ blobUrl: msg.blobUrl, filename: msg.filename, sizeMB: msg.sizeMB });
        return;
      }
      if (msg?.type === 'OFFSCREEN_ERROR') {
        chrome.runtime.onMessage.removeListener(handler);
        reject(new Error(msg.error));
      }
    };
    chrome.runtime.onMessage.addListener(handler);

    // Enviar datos al offscreen (transferir ArrayBuffer para eficiencia)
    chrome.runtime.sendMessage({
      type:     'OFFSCREEN_CONVERT',
      tsData:   tsData.buffer,
      filename: filename
    }).catch(e => {
      chrome.runtime.onMessage.removeListener(handler);
      reject(new Error('No se pudo contactar el conversor: ' + e.message));
    });
  });
}

async function convertHlsToMp4(hlsUrl, title, referer, tabId, videoId) {
  sendProgress('Resolviendo manifiesto HLS…', 2, tabId, videoId, title);
  const manifest = await resolveM3u8(hlsUrl, referer);
  const tsData   = await downloadAllSegments(manifest.url, manifest.text, referer, tabId, videoId, title);
  const sizeMB   = Math.round(tsData.length / 1024 / 1024);

  try {
    const result = await convertWithOffscreen(tsData, title, tabId, videoId, title);
    // Descargar desde la blob URL generada en offscreen
    await chrome.downloads.download({
      url:            result.blobUrl,
      filename:       result.filename,
      saveAs:         false,
      conflictAction: 'uniquify'
    });
    sendProgress('✅ MP4 descargando (' + result.sizeMB + ' MB).', 100, tabId, videoId, title);
    return { ok: true, size: result.sizeMB };

  } catch (err) {
    // Fallback: guardar como .mp4 (contenido TS — abre con VLC)
    sendProgress('⚠ Conversión falló: ' + err.message + '. Guardando TS…', 95, tabId, videoId, title);
    const blob = new Blob([tsData], { type: 'video/mp4' });
    const url  = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: title + '.mp4', saveAs: false, conflictAction: 'uniquify' });
    sendProgress('⚠ Descargado como TS (usar VLC para reproducir).', 100, tabId, videoId, title);
    return { ok: true, size: sizeMB, fallback: true };
  }
}

// ── Función principal de descarga ─────────────────────────────────────────────
async function tryDownload(payload) {
  const { vimeoId, tabId, pageUrl, preferredName } = payload;
  const referer = pageUrl || 'https://vimeo.com/';
  let config = null, configSource = 'none';

  sendProgress('Buscando config en iframe…', 3, tabId, vimeoId, preferredName);
  try {
    const r = await getPlayerConfigFromPage(tabId, vimeoId);
    if (r?.config) { config = r.config; configSource = r.source || 'playerConfig'; }
  } catch(_) {}

  if (!config) {
    sendProgress('Consultando config.js…', 8, tabId, vimeoId, preferredName);
    try { config = await fetchConfigJs(vimeoId, referer); if (config) configSource = 'config.js'; } catch(_) {}
  }
  if (!config) {
    sendProgress('Consultando config.js + cookies…', 14, tabId, vimeoId, preferredName);
    try { config = await fetchConfigJsWithCookies(vimeoId, referer); if (config) configSource = 'config.js+cookies'; } catch(_) {}
  }
  if (!config) {
    sendProgress('Abriendo player en segundo plano…', 20, tabId, vimeoId, preferredName);
    try { config = await fetchConfigViaHiddenTab(vimeoId, pageUrl); if (config) configSource = 'hidden-tab'; } catch(_) {}
  }

  let oembed = null;
  if (!config) {
    sendProgress('Consultando oEmbed…', 30, tabId, vimeoId, preferredName);
    try { oembed = await fetchOEmbed(vimeoId); } catch(_) {}
  }

  const videoTitle = config?.video?.title ||
                     (oembed?.title && oembed.title !== 'undefined' ? oembed.title : null) ||
                     preferredName || ('video-' + vimeoId);
  const title = safeFilename(preferredName || videoTitle);

  if (!config) {
    const oembedMsg = oembed?.title && oembed.title !== 'undefined'
      ? 'oEmbed: "' + oembed.title + '" (' + oembed.author_name + ') — sin archivos directos.'
      : 'Video privado, hash protegido o sin acceso desde esta cuenta.';
    return { ok: false, message: '❌ ' + oembedMsg, oembed };
  }

  const candidates = parseCandidates(config);
  const direct = pickBestDirect(candidates), hls = pickBestHls(candidates);
  sendProgress('Config OK (' + configSource + '). Candidatos: ' + candidates.length, 35, tabId, vimeoId, title);

  if (direct?.url) {
    try {
      await chrome.downloads.download({ url: direct.url, filename: title + '.mp4', saveAs: false, conflictAction: 'uniquify' });
      sendProgress('✅ MP4 directo descargando (' + direct.quality + ').', 100, tabId, vimeoId, title);
      return { ok: true, message: '✅ MP4 directo (' + direct.quality + ').', direct: true };
    } catch(e) { sendProgress('⚠ MP4 directo falló, intentando HLS…', 36, tabId, vimeoId, title); }
  }

  if (hls?.url) {
    return { ok: true, converting: true, hlsUrl: hls.url, title, pageUrl, tabId, videoId: vimeoId, message: '⏳ HLS→MP4…' };
  }

  return { ok: false, message: '❌ Config OK pero sin archivos descargables. Fuente: ' + configSource + ' | Candidatos: ' + candidates.map(c => c.source + '/' + c.quality).join(', ') };
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { type, payload } = msg || {};

    if (type === 'DEBUG_IFRAMES') {
      const tab = await getActiveTab(); if (!tab) return sendResponse({ok:false,iframes:[]});
      const iframes = await runInPage(tab.id, () => Array.from(document.querySelectorAll('iframe')).map(f => ({src:f.src||'',dataSrc:f.getAttribute('data-src')||'',className:f.className||'',id:f.id||''})));
      return sendResponse({ok:true,iframes:iframes||[]});
    }
    if (type === 'GET_EMBEDS') {
      const tab = await getActiveTab(); if (!tab) return sendResponse({ok:false,message:'Sin pestaña activa.'});
      const embeds = await getEmbeds(tab.id);
      return sendResponse({ok:true,embeds:embeds||[],tabId:tab.id,pageUrl:tab.url});
    }
    if (type === 'INJECT_FLOATER') {
      const tab = await getActiveTab(); if (!tab) return sendResponse({ok:false});
      await ensureFloater(tab.id); return sendResponse({ok:true});
    }
    if (type === 'GET_RAW_CONFIG') {
      const r = await getPlayerConfigFromPage(payload.tabId, payload.vimeoId);
      if (!r?.config) {
        const tab = await getActiveTab();
        let cfg = await fetchConfigJs(payload.vimeoId, tab?.url);
        if (!cfg) cfg = await fetchConfigJsWithCookies(payload.vimeoId, tab?.url);
        if (cfg) {
          const cands = parseCandidates(cfg);
          return sendResponse({ok:true,filesKeys:Object.keys(cfg.request?.files||{}),candidates:cands,videoTitle:cfg.video?.title||'',source:'config.js'});
        }
        return sendResponse({ok:false,message:r?.error||'Sin config.'});
      }
      const cands = parseCandidates(r.config);
      return sendResponse({ok:true,filesKeys:Object.keys(r.config?.request?.files||{}),candidates:cands,videoTitle:r.config?.video?.title||'',source:r.source});
    }
    if (type === 'DIAGNOSE_VIDEO') {
      let cfg = null, src = 'none';
      try { const r = await getPlayerConfigFromPage(payload.tabId,payload.vimeoId); if(r?.config){cfg=r.config;src=r.source;} } catch(_){}
      if (!cfg) { const tab=await getActiveTab(); cfg=await fetchConfigJs(payload.vimeoId,tab?.url); if(cfg) src='config.js'; }
      if (!cfg) { const tab=await getActiveTab(); cfg=await fetchConfigJsWithCookies(payload.vimeoId,tab?.url); if(cfg) src='config.js+cookies'; }
      if (!cfg) { cfg=await fetchConfigViaHiddenTab(payload.vimeoId,payload.pageUrl); if(cfg) src='hidden-tab'; }
      if (!cfg) {
        const oe=await fetchOEmbed(payload.vimeoId);
        if(oe) return sendResponse({ok:true,message:'oEmbed: "'+oe.title+'" de '+oe.author_name+' | Sin archivos directos. Video privado o restringido.'});
        return sendResponse({ok:false,message:'❌ Sin acceso al video '+payload.vimeoId+'. Asegúrate de estar logueado en Vimeo en este navegador.'});
      }
      const cands=parseCandidates(cfg),direct=pickBestDirect(cands),hls=pickBestHls(cands);
      return sendResponse({ok:true,message:'✅ "'+(cfg.video?.title||'?')+'" | Fuente: '+src+' | MP4: '+(direct?direct.source+' '+direct.quality:'NO')+' | HLS: '+(hls?'SÍ':'NO')+' | Candidatos: '+cands.length});
    }
    if (type === 'TRY_DOWNLOAD') {
      const {allowedHost} = await chrome.storage.local.get(['allowedHost']);
      if (!allowedHost) return sendResponse({ok:false,message:'Primero guarda el dominio permitido.'});
      if (!hostAllowed(payload.pageUrl, allowedHost)) return sendResponse({ok:false,message:'Dominio no permitido: '+new URL(payload.pageUrl).hostname});
      if (!payload.vimeoId) return sendResponse({ok:false,message:'Sin Vimeo ID.'});
      const result = await tryDownload(payload);
      return sendResponse(result);
    }
    if (type === 'CONVERT_HLS') {
      try {
        const res = await convertHlsToMp4(payload.hlsUrl, payload.title, payload.referer, payload.tabId, payload.videoId);
        return sendResponse({ok:true,message:'✅ MP4 descargado ('+(res.size||'?')+' MB)'+(res.fallback?' [TS-fallback]':'')});
      } catch(e) {
        sendProgress('❌ '+e.message,-1,payload.tabId,payload.videoId,payload.title);
        return sendResponse({ok:false,message:'❌ '+e.message});
      }
    }
    if (type === '__VIMEO_CONFIG_FROM_FRAME__') {
      chrome.runtime.sendMessage({ __vimeoExtConfig:true, videoId:msg.videoId, config:msg.config }).catch(()=>{});
      return sendResponse({ok:true});
    }
  })();
  return true;
});

// ── Iniciar offscreen al arrancar el service worker ───────────────────────────
// Esto precarga ffmpeg.wasm antes de que el usuario presione Descargar
ensureOffscreen().catch(e => console.warn('[VD] init offscreen:', e.message));
