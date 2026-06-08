/* background.js v9.1
 * HLS -> MP4: descarga segmentos .ts y los envía al downloader.js
 * que usa mux.js para reempaquetar TS->MP4 en el navegador.
 * Si mux.js no logra el remux, guarda el .ts concatenado como fallback.
 */
'use strict';

const CHUNK_SIZE = 4 * 1024 * 1024;

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
    await chrome.scripting.executeScript({ target: { tabId }, files: ['page_scanner.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['vimeo_frame.js'],  world: 'MAIN' });
  } catch(e) { console.warn('[VD] ensureScripts:', e.message); }
}
async function ensureFloater(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['floater.css'] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['floater.js'] });
  } catch(e) { console.warn('[VD] ensureFloater:', e.message); }
}
async function getEmbeds(tabId) {
  await ensureScripts(tabId);
  await new Promise(r => setTimeout(r, 600));
  return runInPage(tabId, () =>
    typeof window.__scanVimeoEmbedsNow === 'function'
      ? window.__scanVimeoEmbedsNow()
      : (window.__VIMEO_EMBEDS__ || [])
  );
}
async function getPlayerConfig(tabId, videoId) {
  return runInPage(tabId, (vid) =>
    typeof window.__getVimeoConfig === 'function'
      ? window.__getVimeoConfig(vid)
      : { config: null, error: 'scanner no cargado' }
  , [String(videoId)]);
}
async function fetchVimeoConfigJs(videoId, referer) {
  const urls = [
    `https://player.vimeo.com/video/${videoId}/config`,
    `https://player.vimeo.com/video/${videoId}/config?autopause=1&autoplay=0`,
  ];
  const headers = {
    'Referer': referer || 'https://vimeo.com/',
    'Origin':  referer ? new URL(referer).origin : 'https://vimeo.com',
  };
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, credentials: 'omit' });
      if (!res.ok) continue;
      const json = await res.json();
      if (json && json.request && json.video) return json;
    } catch(_) {}
  }
  return null;
}
async function fetchOEmbed(videoId) {
  try {
    const url = `https://vimeo.com/api/oembed.json?url=https://vimeo.com/${videoId}&width=1920`;
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    return await res.json();
  } catch(_) { return null; }
}
function parseCandidates(config) {
  const out = [], seen = new Set();
  function add(c) {
    if (c?.url && !seen.has(c.url)) { seen.add(c.url); out.push(c); }
  }
  const prog = config?.request?.files?.progressive || config?.files?.progressive || [];
  if (Array.isArray(prog)) {
    prog.forEach(f => {
      if (f?.url) add({ source:'progressive', quality:String(f.quality||f.height||'sd'),
                        height:Number(f.height||0), mime:'video/mp4', url:f.url, size:f.size||null });
    });
  }
  const dl = config?.download || config?.request?.files?.download || [];
  if (Array.isArray(dl)) {
    dl.forEach(f => {
      const url = f?.link || f?.url;
      if (url) add({ source:'download', quality:String(f.quality||f.height||'sd'),
                     height:Number(f.height||0), mime:'video/mp4', url, size:f.size||null });
    });
  }
  const hlsCdns = config?.request?.files?.hls?.cdns || config?.files?.hls?.cdns || {};
  Object.values(hlsCdns).forEach(c => {
    if (c?.url) add({ source:'hls', quality:'hls', height:0, mime:'application/x-mpegURL', url:c.url });
  });
  const hlsUrl = config?.request?.files?.hls?.url || config?.files?.hls?.url;
  if (hlsUrl) add({ source:'hls', quality:'hls', height:0, mime:'application/x-mpegURL', url:hlsUrl });
  const dashCdns = config?.request?.files?.dash?.cdns || config?.files?.dash?.cdns || {};
  Object.values(dashCdns).forEach(c => {
    if (c?.url) add({ source:'dash', quality:'dash', height:0, mime:'application/dash+xml', url:c.url });
  });
  function deepMp4(obj, d) {
    if (!obj || d > 6) return;
    if (typeof obj === 'string') {
      if (/\.mp4/i.test(obj) && /^https?:\/\//.test(obj))
        add({ source:'deep', quality:'unknown', height:0, mime:'video/mp4', url:obj });
      return;
    }
    if (Array.isArray(obj)) { obj.forEach(i => deepMp4(i, d+1)); return; }
    if (typeof obj === 'object') Object.values(obj).forEach(v => deepMp4(v, d+1));
  }
  deepMp4(config, 0);
  return out;
}
function pickBestDirect(candidates) {
  return candidates
    .filter(x => /progressive|download|deep/.test(x.source))
    .sort((a,b) => (b.height||0) - (a.height||0))[0] || null;
}
function pickBestHls(candidates) {
  return candidates.find(x => x.source === 'hls') || null;
}

// HLS: resolver manifiesto y elegir mejor variante
async function resolveM3u8(url, referer) {
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
      const uri = (lines[i+1]||'').trim();
      if (uri && !uri.startsWith('#'))
        variants.push({ bw: bwM ? parseInt(bwM[1]) : 0, uri });
    }
  }
  if (!variants.length) throw new Error('Sin variantes en el manifiesto.');
  variants.sort((a,b) => b.bw - a.bw);
  const best = variants[0].uri.startsWith('http')
    ? variants[0].uri
    : new URL(variants[0].uri, url).href;
  sendProgress('Variante '+Math.round(variants[0].bw/1000)+'kbps seleccionada…', 5);
  const res2 = await fetch(best, { headers: h });
  if (!res2.ok) throw new Error('Variante HTTP ' + res2.status);
  return { url: best, text: await res2.text() };
}

// HLS: descargar todos los segmentos como ArrayBuffers concatenados
async function downloadAllSegments(manifestUrl, manifestText, referer, tabId, videoId, title) {
  const h = referer ? { 'Referer': referer } : {};
  const lines = manifestText.split('\n').map(l => l.trim());
  const segs  = lines.filter(l => l && !l.startsWith('#'));
  if (!segs.length) throw new Error('Sin segmentos en el manifiesto.');
  const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  const buffers = [];
  let totalBytes = 0;
  for (let j = 0; j < segs.length; j++) {
    const segUrl = segs[j].startsWith('http') ? segs[j] : base + segs[j];
    if (j % 5 === 0 || j === segs.length - 1)
      sendProgress('Segmento '+(j+1)+'/'+segs.length,
        Math.round((j / segs.length) * 60) + 8, tabId, videoId, title);
    let attempts = 4;
    while (attempts-- > 0) {
      try {
        const r = await fetch(segUrl, { headers: h });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = await r.arrayBuffer();
        buffers.push(buf);
        totalBytes += buf.byteLength;
        break;
      } catch(e) {
        if (attempts === 0) throw new Error('Seg '+(j+1)+' fallido: '+e.message);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  // Concatenar todos los buffers en un solo Uint8Array
  sendProgress('Ensamblando '+Math.round(totalBytes/1024/1024)+' MB…', 70, tabId, videoId, title);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const buf of buffers) {
    merged.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return merged;
}

// Esperar que una tab esté completamente cargada
async function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timeout tab (' + timeoutMs/1000 + 's).'));
    }, timeoutMs);
    function listener(id, info) {
      if (id !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 250);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Enviar datos al downloader.html para conversión TS->MP4 y descarga
async function triggerMp4Download(tsData, filename, tabId, videoId, title) {
  return new Promise(async (resolve, reject) => {
    sendProgress('Abriendo conversor MP4…', 72, tabId, videoId, title);
    let dlTabId;
    try {
      const tab = await chrome.tabs.create({
        url: chrome.runtime.getURL('downloader.html'),
        active: false
      });
      dlTabId = tab.id;
    } catch(e) { return reject(new Error('No se pudo crear tab: ' + e.message)); }

    const cleanup = () => chrome.tabs.remove(dlTabId).catch(() => {});

    try {
      await waitTabComplete(dlTabId, 15000);
      const totalChunks = Math.ceil(tsData.length / CHUNK_SIZE);
      sendProgress('Transfiriendo '+Math.round(tsData.length/1024/1024)+' MB ('+totalChunks+' partes)…',
        73, tabId, videoId, title);

      // Enviar metadatos: filename SIN extensión, el downloader elige .mp4 o .ts
      await chrome.tabs.sendMessage(dlTabId, {
        type: 'DOWNLOAD_META',
        filename: filename,   // sin extensión
        mime: 'video/mp2t',   // TS original; downloader intentará remux a MP4
        totalChunks
      });

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const slice = tsData.slice(start, Math.min(start + CHUNK_SIZE, tsData.length));
        await chrome.tabs.sendMessage(dlTabId, {
          type: 'DOWNLOAD_CHUNK', index: i, data: Array.from(slice)
        });
        sendProgress('Parte '+(i+1)+'/'+totalChunks,
          73 + Math.round(((i+1)/totalChunks) * 20), tabId, videoId, title);
      }

      sendProgress('Convirtiendo a MP4…', 94, tabId, videoId, title);

      await new Promise((res2, rej2) => {
        const t2 = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(onDone);
          cleanup();
          rej2(new Error('Timeout confirmación (60s).'));
        }, 60000);
        function onDone(m, sender) {
          if (sender.tab?.id !== dlTabId) return;
          if (m?.type === 'DOWNLOAD_STARTED' || m?.type === 'DOWNLOAD_ERROR') {
            clearTimeout(t2);
            chrome.runtime.onMessage.removeListener(onDone);
            cleanup();
            if (m.type === 'DOWNLOAD_STARTED') {
              sendProgress('✅ '+(m.format==='mp4'?'MP4':'TS')+' descargado ('+(m.sizeMB||'?')+' MB)', 100, tabId, videoId, title);
              res2(m);
            } else {
              rej2(new Error(m.error || 'Error en conversor.'));
            }
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
    } catch(e) { cleanup(); reject(new Error('Transfer: ' + e.message)); }
  });
}

// Conversión HLS completa -> MP4
async function convertHlsToMp4(hlsUrl, title, referer, tabId, videoId) {
  sendProgress('Resolviendo manifiesto HLS…', 2, tabId, videoId, title);
  const manifest = await resolveM3u8(hlsUrl, referer);
  const tsData   = await downloadAllSegments(manifest.url, manifest.text, referer, tabId, videoId, title);
  const sizeMB   = Math.round(tsData.length / 1024 / 1024);
  await triggerMp4Download(tsData, title, tabId, videoId, title);
  return { ok: true, size: sizeMB };
}

// Función principal de descarga
async function tryDownload(payload) {
  const { vimeoId, tabId, pageUrl, preferredName } = payload;
  const referer = pageUrl || 'https://vimeo.com/';
  let config = null, configSource = 'none';

  try {
    const r = await getPlayerConfig(tabId, vimeoId);
    if (r?.config) { config = r.config; configSource = r.source || 'playerConfig'; }
  } catch(_) {}

  if (!config) {
    sendProgress('Consultando config.js…', 8, tabId, vimeoId, preferredName);
    try {
      config = await fetchVimeoConfigJs(vimeoId, referer);
      if (config) configSource = 'config.js';
    } catch(_) {}
  }

  let oembed = null;
  if (!config) {
    sendProgress('Consultando oEmbed…', 12, tabId, vimeoId, preferredName);
    try { oembed = await fetchOEmbed(vimeoId); } catch(_) {}
  }

  const videoTitle = config?.video?.title || oembed?.title || preferredName || ('video-'+vimeoId);
  const title      = safeFilename(preferredName || videoTitle);

  if (!config) {
    return {
      ok: false,
      message: '❌ No se pudo obtener playerConfig ni config.js. ' +
        (oembed ? 'oEmbed OK ("'+oembed.title+'" de '+oembed.author_name+') pero sin URL directa.' :
                  'Video privado o sin embedding permitido.'),
      oembed: oembed || null
    };
  }

  const candidates = parseCandidates(config);
  const direct     = pickBestDirect(candidates);
  const hls        = pickBestHls(candidates);

  sendProgress('Config OK ('+configSource+'). Candidatos: '+candidates.length, 15, tabId, vimeoId, title);

  // Prioridad 1: MP4 directo
  if (direct?.url) {
    try {
      await chrome.downloads.download({
        url: direct.url, filename: title + '.mp4',
        saveAs: false, conflictAction: 'uniquify'
      });
      sendProgress('✅ MP4 directo descargando ('+direct.quality+').', 100, tabId, vimeoId, title);
      return { ok:true, message:'✅ Descarga MP4 directa iniciada ('+direct.quality+').', direct:true };
    } catch(e) {
      sendProgress('⚠ MP4 directo falló, intentando HLS→MP4…', 20, tabId, vimeoId, title);
    }
  }

  // Prioridad 2: HLS -> MP4
  if (hls?.url) {
    return {
      ok: true, converting: true,
      hlsUrl: hls.url, title, pageUrl, tabId,
      videoId: vimeoId,
      message: '⏳ Iniciando HLS→MP4…'
    };
  }

  return {
    ok: false,
    message: '❌ Config encontrada pero sin archivos descargables. Candidatos: ' +
      candidates.map(c => c.source+'/'+c.quality).join(', ')
  };
}

// Message handler
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { type, payload } = msg || {};

    if (type === 'DEBUG_IFRAMES') {
      const tab = await getActiveTab();
      if (!tab) return sendResponse({ ok:false, iframes:[] });
      const iframes = await runInPage(tab.id, () =>
        Array.from(document.querySelectorAll('iframe')).map(f => ({
          src: f.src||'', dataSrc: f.getAttribute('data-src')||'',
          className: f.className||'', id: f.id||''
        }))
      );
      return sendResponse({ ok:true, iframes: iframes||[] });
    }

    if (type === 'GET_EMBEDS') {
      const tab = await getActiveTab();
      if (!tab) return sendResponse({ ok:false, message:'Sin pestaña activa.' });
      const embeds = await getEmbeds(tab.id);
      return sendResponse({ ok:true, embeds:embeds||[], tabId:tab.id, pageUrl:tab.url });
    }

    if (type === 'INJECT_FLOATER') {
      const tab = await getActiveTab();
      if (!tab) return sendResponse({ ok:false });
      await ensureFloater(tab.id);
      return sendResponse({ ok:true });
    }

    if (type === 'GET_RAW_CONFIG') {
      const r = await getPlayerConfig(payload.tabId, payload.vimeoId);
      if (!r?.config) {
        const tab = await getActiveTab();
        const cfg2 = await fetchVimeoConfigJs(payload.vimeoId, tab?.url);
        if (cfg2) {
          const cands = parseCandidates(cfg2);
          return sendResponse({ ok:true, filesKeys:Object.keys(cfg2.request?.files||{}),
            candidates:cands, videoTitle:cfg2.video?.title||'', source:'config.js' });
        }
        return sendResponse({ ok:false, message:r?.error||'Sin config.' });
      }
      const cands = parseCandidates(r.config);
      return sendResponse({ ok:true, filesKeys:Object.keys(r.config?.request?.files||{}),
        candidates:cands, videoTitle:r.config?.video?.title||'', source:r.source });
    }

    if (type === 'DIAGNOSE_VIDEO') {
      let cfg=null, src='none';
      try { const r=await getPlayerConfig(payload.tabId,payload.vimeoId); if(r?.config){cfg=r.config;src=r.source;} } catch(_){}
      if (!cfg) { const tab=await getActiveTab(); const c2=await fetchVimeoConfigJs(payload.vimeoId,tab?.url); if(c2){cfg=c2;src='config.js';} }
      if (!cfg) {
        const oe=await fetchOEmbed(payload.vimeoId);
        if(oe) return sendResponse({ok:true,message:'oEmbed: "'+oe.title+'" de '+oe.author_name+' | Sin archivos directos.'});
        return sendResponse({ok:false,message:'❌ Sin acceso al video '+payload.vimeoId});
      }
      const cands=parseCandidates(cfg);
      const direct=pickBestDirect(cands), hls=pickBestHls(cands);
      return sendResponse({ok:true,message:'✅ "'+(cfg.video?.title||'?')+'" | Fuente: '+src+' | MP4: '+(direct?direct.source+' '+direct.quality:'NO')+' | HLS: '+(hls?'SÍ':'NO')+' | Candidatos: '+cands.length});
    }

    if (type === 'TRY_DOWNLOAD') {
      const { allowedHost } = await chrome.storage.local.get(['allowedHost']);
      if (!allowedHost) return sendResponse({ok:false,message:'Primero guarda el dominio permitido.'});
      if (!hostAllowed(payload.pageUrl, allowedHost))
        return sendResponse({ok:false,message:'Dominio no permitido: '+new URL(payload.pageUrl).hostname});
      if (!payload.vimeoId) return sendResponse({ok:false,message:'Sin Vimeo ID.'});
      const result = await tryDownload(payload);
      return sendResponse(result);
    }

    if (type === 'CONVERT_HLS') {
      try {
        const res = await convertHlsToMp4(
          payload.hlsUrl, payload.title, payload.referer,
          payload.tabId, payload.videoId
        );
        return sendResponse({ ok:true, message:'✅ MP4 descargado ('+res.size+' MB)' });
      } catch(e) {
        sendProgress('❌ '+e.message, -1, payload.tabId, payload.videoId, payload.title);
        return sendResponse({ ok:false, message:'❌ '+e.message });
      }
    }
  })();
  return true;
});
