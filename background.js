/* background.js v9.7
 *
 * Estrategias de obtención del playerConfig (en orden):
 *  1. playerConfig desde iframe ya cargado en la página (world:MAIN)
 *  2. postMessage interceptado por vimeo_interceptor.js
 *  3. config.js público sin autenticación
 *  4. config.js CON cookies de sesión de Vimeo (credentials:include)
 *  5. Abrir player.vimeo.com en tab oculta y extraer config desde adentro
 *  6. oEmbed (solo metadata)
 *
 * Descarga:
 *  A. MP4 progresivo directo
 *  B. HLS -> segmentos -> ffmpeg.wasm remux -> .mp4
 *
 * v9.7: fix timeout tab
 *  - waitTabComplete: 60 s (antes 15 s) — da tiempo a que el DOM cargue
 *  - triggerMp4Download: espera mensaje DOWNLOADER_READY (emitido por downloader.js
 *    cuando ffmpeg.wasm ya está cargado) antes de enviar chunks.
 *    Timeout READY: 90 s | Timeout conversión final: 300 s
 */
'use strict';

const CHUNK_SIZE = 4 * 1024 * 1024;

// ── Utils ────────────────────────────────────────────────────────────────────
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

// ── Obtener embeds ───────────────────────────────────────────────────────────
async function getEmbeds(tabId) {
  await ensureScripts(tabId);
  await new Promise(r => setTimeout(r, 700));
  return runInPage(tabId, () =>
    typeof window.__scanVimeoEmbedsNow === 'function'
      ? window.__scanVimeoEmbedsNow()
      : (window.__VIMEO_EMBEDS__ || [])
  );
}

// ── Estrategia 1+2: playerConfig desde página ───────────────────────────────
async function getPlayerConfigFromPage(tabId, videoId) {
  return runInPage(tabId, (vid) =>
    typeof window.__getVimeoConfig === 'function'
      ? window.__getVimeoConfig(vid)
      : { config: null, error: 'scanner no cargado' }
  , [String(videoId)]);
}

// ── Estrategia 3: config.js sin auth ────────────────────────────────────────
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

// ── Estrategia 4: config.js CON cookies de sesión ───────────────────────────
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
        credentials: 'include',
        mode: 'cors'
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.request?.files) return json;
    } catch(_) {}
  }
  return null;
}

// ── Estrategia 5: abrir player en tab oculta ────────────────────────────────
async function fetchConfigViaHiddenTab(videoId, pageUrl) {
  return new Promise(async (resolve) => {
    const playerUrl = `https://player.vimeo.com/video/${videoId}?autoplay=0&dnt=1`;
    let tabId;
    try {
      const tab = await chrome.tabs.create({ url: playerUrl, active: false });
      tabId = tab.id;
    } catch(e) { return resolve(null); }

    const cleanup = () => chrome.tabs.remove(tabId).catch(() => {});
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 12000);

    const msgListener = (msg) => {
      if (msg?.__vimeoExtConfig && String(msg.videoId) === String(videoId)) {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(msgListener);
        cleanup();
        resolve(msg.config);
      }
    };
    chrome.runtime.onMessage.addListener(msgListener);

    chrome.tabs.onUpdated.addListener(async function listener(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      await new Promise(r => setTimeout(r, 1000));
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
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
        if (cfg) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(msgListener);
          cleanup();
          resolve(cfg);
        }
      } catch(_) {}
    });
  });
}

// ── Estrategia 6: oEmbed ─────────────────────────────────────────────────────
async function fetchOEmbed(videoId) {
  try {
    const res = await fetch(
      `https://vimeo.com/api/oembed.json?url=https://vimeo.com/${videoId}&width=1920`,
      { credentials: 'include' }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.title && !data?.html) return null;
    return data;
  } catch(_) { return null; }
}

// ── Parsear candidatos ───────────────────────────────────────────────────────
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

// ── HLS downloader ───────────────────────────────────────────────────────────
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
      sendProgress('Segmento '+(j+1)+'/'+segs.length, Math.round((j/segs.length)*60)+8, tabId, videoId, title);
    let attempts=4;
    while (attempts-->0) {
      try {
        const r=await fetch(segUrl,{headers:h}); if(!r.ok) throw new Error('HTTP '+r.status);
        const buf=await r.arrayBuffer(); buffers.push(buf); totalBytes+=buf.byteLength; break;
      } catch(e) { if(attempts===0) throw new Error('Seg '+(j+1)+': '+e.message); await new Promise(r=>setTimeout(r,1000)); }
    }
  }
  sendProgress('Ensamblando '+Math.round(totalBytes/1024/1024)+' MB…', 70, tabId, videoId, title);
  const merged=new Uint8Array(totalBytes); let offset=0;
  for (const buf of buffers) { merged.set(new Uint8Array(buf),offset); offset+=buf.byteLength; }
  return merged;
}

// ── Blob download via tab ────────────────────────────────────────────────────

/**
 * Espera a que la tab termine de cargar el HTML (status:complete).
 * Timeout 60 s — solo el HTML, no el WASM.
 */
async function waitTabComplete(tabId, ms = 60_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(l);
      reject(new Error('Timeout cargando tab ('+Math.round(ms/1000)+'s).'));
    }, ms);
    function l(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(t);
      chrome.tabs.onUpdated.removeListener(l);
      setTimeout(resolve, 300);
    }
    chrome.tabs.onUpdated.addListener(l);
  });
}

/**
 * Espera a que downloader.js emita DOWNLOADER_READY (ffmpeg.wasm ya cargado).
 * Timeout 90 s — CDN puede tardar en primera carga.
 */
async function waitDownloaderReady(dlTabId, ms = 90_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(l);
      reject(new Error('Timeout esperando DOWNLOADER_READY ('+Math.round(ms/1000)+'s). CDN de ffmpeg.wasm no respondió.'));
    }, ms);
    function l(msg, sender) {
      if (sender.tab?.id !== dlTabId) return;
      if (msg?.type === 'DOWNLOADER_READY') {
        clearTimeout(t);
        chrome.runtime.onMessage.removeListener(l);
        resolve();
      }
    }
    chrome.runtime.onMessage.addListener(l);
  });
}

async function triggerMp4Download(tsData, filename, tabId, videoId, title) {
  return new Promise(async (resolve, reject) => {
    sendProgress('Abriendo conversor MP4…', 72, tabId, videoId, title);

    let dlTabId;
    try {
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html'), active: false });
      dlTabId = tab.id;
    } catch(e) {
      return reject(new Error('No se pudo crear tab: ' + e.message));
    }

    const cleanup = () => chrome.tabs.remove(dlTabId).catch(() => {});

    try {
      // ── Paso 1: esperar que el HTML cargue (DOM ready) ─────────────────
      sendProgress('Cargando conversor…', 72, tabId, videoId, title);
      await waitTabComplete(dlTabId, 60_000);

      // ── Paso 2: esperar que ffmpeg.wasm esté listo (puede tardar ~30s) ─
      sendProgress('Cargando ffmpeg.wasm (primera vez ~30s)…', 73, tabId, videoId, title);
      await waitDownloaderReady(dlTabId, 90_000);

      // ── Paso 3: transferir chunks ───────────────────────────────────────
      const totalChunks = Math.ceil(tsData.length / CHUNK_SIZE);
      sendProgress('Transfiriendo ' + Math.round(tsData.length / 1024 / 1024) + ' MB…', 74, tabId, videoId, title);

      await chrome.tabs.sendMessage(dlTabId, {
        type: 'DOWNLOAD_META', filename, mime: 'video/mp2t', totalChunks
      });

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const slice = tsData.slice(start, Math.min(start + CHUNK_SIZE, tsData.length));
        await chrome.tabs.sendMessage(dlTabId, {
          type: 'DOWNLOAD_CHUNK', index: i, data: Array.from(slice)
        });
        sendProgress(
          'Parte ' + (i+1) + '/' + totalChunks,
          74 + Math.round(((i+1) / totalChunks) * 18),
          tabId, videoId, title
        );
      }

      // ── Paso 4: esperar conversión (hasta 5 min para videos largos) ────
      sendProgress('Convirtiendo TS→MP4…', 93, tabId, videoId, title);

      await new Promise((res2, rej2) => {
        const t2 = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(onDone);
          cleanup();
          rej2(new Error('Timeout conversión (300s).'));
        }, 300_000);

        function onDone(m, sender) {
          if (sender.tab?.id !== dlTabId) return;
          if (m?.type === 'DOWNLOAD_STARTED' || m?.type === 'DOWNLOAD_ERROR') {
            clearTimeout(t2);
            chrome.runtime.onMessage.removeListener(onDone);
            cleanup();
            if (m.type === 'DOWNLOAD_STARTED') res2(m);
            else rej2(new Error(m.error || 'Error en conversión.'));
          }
        }
        chrome.runtime.onMessage.addListener(onDone);

        chrome.tabs.sendMessage(dlTabId, { type: 'DOWNLOAD_FINALIZE' })
          .catch(e => {
            clearTimeout(t2);
            chrome.runtime.onMessage.removeListener(onDone);
            cleanup();
            rej2(new Error('FINALIZE: ' + e.message));
          });
      });

      resolve();

    } catch(e) {
      cleanup();
      reject(new Error('Transfer: ' + e.message));
    }
  });
}

async function convertHlsToMp4(hlsUrl, title, referer, tabId, videoId) {
  sendProgress('Resolviendo manifiesto HLS…', 2, tabId, videoId, title);
  const manifest = await resolveM3u8(hlsUrl, referer);
  const tsData   = await downloadAllSegments(manifest.url, manifest.text, referer, tabId, videoId, title);
  const sizeMB   = Math.round(tsData.length / 1024 / 1024);
  await triggerMp4Download(tsData, title, tabId, videoId, title);
  return { ok: true, size: sizeMB };
}

// ── Función principal de descarga ───────────────────────────────────────────
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
        return sendResponse({ok:true,message:'✅ MP4 descargado ('+res.size+' MB)'});
      } catch(e) {
        sendProgress('❌ '+e.message, -1, payload.tabId, payload.videoId, payload.title);
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
