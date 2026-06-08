/* popup.js v9.5
 * Mejoras sobre v9.0:
 *  1. parseInput()       — JSON.parse con fallback Regex para texto sucio
 *  2. extractCandidates()— soporta progressive + HLS cdns + links descarga
 *  3. safeTitle()        — limpieza de caracteres inválidos para nombre de archivo
 *  4. renderCard()       — extrae título real, muestra cmd FFmpeg para HLS
 *  5. Bookmarklet        — sección arrastrable + botón copiar
 */
'use strict';

const $ = id => document.getElementById(id);
const statusEl = $('status');
const videosEl = $('videos');
const logEl    = $('log');

let sessionLog = [];

function log(msg) {
  const t = new Date().toLocaleTimeString('es-CL', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  sessionLog.push('['+t+'] '+msg);
  if (sessionLog.length > 200) sessionLog.shift();
  logEl.textContent = sessionLog.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg, color) {
  statusEl.textContent = msg;
  statusEl.style.color = color || '#94a3b8';
}

function btnState(btn, state, label) {
  btn.setAttribute('data-state', state || '');
  if (label) btn.textContent = label;
}

// ────────────────────────────────────────────────────────────────────────
// MEJORA 3: Limpieza de título para nombre de archivo
// ────────────────────────────────────────────────────────────────────────
function safeTitle(raw, fallback) {
  if (!raw || String(raw).trim() === '' || raw === 'undefined') return fallback || 'video-vimeo';
  return String(raw)
    .replace(/[\\\/:\*\?"<>|]+/g, '-')   // caracteres invalidos en nombres de archivo
    .replace(/\s+/g, ' ')                  // espacios multiples
    .replace(/^[\s\-]+|[\s\-]+$/g, '')    // trim guiones y espacios
    .slice(0, 160) || fallback || 'video-vimeo';
}

// ────────────────────────────────────────────────────────────────────────
// MEJORA 1: Parser robusto con fallback Regex
// ────────────────────────────────────────────────────────────────────────
/**
 * parseInput(text)
 * Intenta parsear un JSON de playerConfig.
 * Si falla (texto sucio/incompleto), usa Regex para rescatar URLs mp4/m3u8.
 * Devuelve { config, rescued, urls } donde:
 *   config  = objeto JSON parseado (o null)
 *   rescued = true si se usó el fallback regex
 *   urls    = array de URLs encontradas (solo en modo rescued)
 */
function parseInput(text) {
  // Intento 1: JSON limpio
  try {
    const config = JSON.parse(text);
    if (config && typeof config === 'object') {
      return { config, rescued: false, urls: [] };
    }
  } catch (_) {
    // JSON.parse falló, continuar con regex
  }

  // Intento 2: Buscar JSON embebido dentro del texto (puede tener basura alrededor)
  try {
    const jsonMatch = text.match(/\{[\s\S]*\"request\"[\s\S]*\"files\"[\s\S]*\}/);
    if (jsonMatch) {
      const config = JSON.parse(jsonMatch[0]);
      if (config?.request?.files) {
        return { config, rescued: true, urls: [], note: 'JSON extraído con regex de texto sucio' };
      }
    }
  } catch (_) {}

  // Intento 3: Fallback regex — rescatar URLs directas de video
  const urlRegex = /https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*/gi;
  const found = [...new Set(text.match(urlRegex) || [])];

  if (found.length > 0) {
    log('⚠ JSON inválido — rescatadas ' + found.length + ' URL(s) por Regex.');
    return { config: null, rescued: true, urls: found };
  }

  return { config: null, rescued: false, urls: [] };
}

// ────────────────────────────────────────────────────────────────────────
// MEJORA 2: Extractor de candidatos con soporte HLS
// ────────────────────────────────────────────────────────────────────────
/**
 * extractCandidates(config)
 * Extrae todos los enlaces de descarga desde un playerConfig:
 *  - Archivos progresivos MP4  (request.files.progressive)
 *  - HLS CDNs                  (request.files.hls.cdns)
 *  - Links directos download   (download[])
 * Devuelve array ordenado: MP4 progresivos > descargas directas > HLS
 */
function extractCandidates(config) {
  const candidates = [];
  const seen = new Set();

  function add(c) {
    if (c?.url && !seen.has(c.url)) { seen.add(c.url); candidates.push(c); }
  }

  // MP4 progresivos
  const progressive = config?.request?.files?.progressive
                   || config?.files?.progressive
                   || [];
  if (Array.isArray(progressive)) {
    progressive.forEach(f => {
      if (f?.url) add({
        type: 'mp4',
        quality: String(f.quality || f.height || 'sd'),
        height: Number(f.height || 0),
        url: f.url,
        size: f.size || null
      });
    });
  }

  // Links de descarga directa (solo disponibles si el dueño activó descarga)
  const downloads = config?.download
                 || config?.request?.files?.download
                 || [];
  if (Array.isArray(downloads)) {
    downloads.forEach(f => {
      const u = f?.link || f?.url;
      if (u) add({
        type: 'mp4-dl',
        quality: String(f.quality || f.height || 'sd'),
        height: Number(f.height || 0),
        url: u,
        size: f.size || null
      });
    });
  }

  // HLS (si no hay MP4 progresivos)
  const hlsCdns = config?.request?.files?.hls?.cdns
               || config?.files?.hls?.cdns
               || {};
  Object.entries(hlsCdns).forEach(([cdn, data]) => {
    if (data?.url) add({
      type: 'hls',
      quality: 'HLS (' + cdn + ')',
      height: 0,
      url: data.url
    });
  });
  const hlsUrl = config?.request?.files?.hls?.url || config?.files?.hls?.url;
  if (hlsUrl) add({ type: 'hls', quality: 'HLS', height: 0, url: hlsUrl });

  // Ordenar: MP4 directo por calidad desc, luego HLS
  candidates.sort((a, b) => {
    if (a.type !== 'hls' && b.type === 'hls') return -1;
    if (a.type === 'hls' && b.type !== 'hls') return  1;
    return (b.height || 0) - (a.height || 0);
  });

  return candidates;
}

// ────────────────────────────────────────────────────────────────────────
// Estado general
// ────────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['allowedHost'], ({ allowedHost }) => {
  if (allowedHost) {
    $('allowedHost').value = allowedHost;
    $('hostInfo').textContent = 'Dominio activo: ' + allowedHost;
  }
});

$('saveHost').addEventListener('click', () => {
  const val = $('allowedHost').value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!val) { log('⚠ Ingresa un dominio válido.'); return; }
  chrome.storage.local.set({ allowedHost: val }, () => {
    $('hostInfo').textContent = 'Dominio activo: ' + val;
    log('✅ Dominio guardado: ' + val);
  });
});

$('clearLog').addEventListener('click', () => {
  sessionLog = []; logEl.textContent = 'Sin actividad.';
});

$('refresh').addEventListener('click', () => {
  videosEl.innerHTML = '';
  scanEmbeds();
});

// Escuchar progreso desde background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CONVERT_PROGRESS') {
    const pct = msg.pct >= 0 ? ' ['+msg.pct+'%]' : '';
    log(pct + ' ' + (msg.message || ''));
    setStatus((msg.message||'')+pct,
      msg.pct >= 100 ? '#86efac' : msg.pct < 0 ? '#fca5a5' : '#93c5fd');
  }
});

// ────────────────────────────────────────────────────────────────────────
// MEJORA 4: Bookmarklet
// ────────────────────────────────────────────────────────────────────────
const BOOKMARKLET_CODE = `javascript:(function(){try{var cfg=window.vimeo&&window.vimeo.clip_page_config;if(!cfg){var el=document.getElementById('config');if(el)cfg=JSON.parse(el.textContent);}if(!cfg){var scripts=document.querySelectorAll('script');for(var i=0;i<scripts.length;i++){var m=scripts[i].textContent.match(/playerConfig\s*=\s*(\{[\s\S]+?\});/);if(m){try{cfg=JSON.parse(m[1]);}catch(e){}}if(cfg)break;}}if(cfg){navigator.clipboard.writeText(JSON.stringify(cfg,null,2)).then(function(){alert('\u2705 playerConfig copiado al portapapeles. P\u00e9galo en el log de diagn\u00f3stico de la extensi\u00f3n.');}).catch(function(){prompt('Copia esto:',JSON.stringify(cfg));});}else{alert('\u274c No se encontr\u00f3 playerConfig en esta p\u00e1gina.');}}catch(e){alert('Error: '+e.message);}})();`;

// Inyectar el href en el enlace arrastrable
document.addEventListener('DOMContentLoaded', () => {
  const bmDrag = $('bm-drag');
  const bmCode = $('bm-code');
  const bmCopy = $('bm-copy');

  if (bmDrag) bmDrag.href = BOOKMARKLET_CODE;
  if (bmCode) bmCode.value = BOOKMARKLET_CODE;

  if (bmCopy) {
    bmCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(BOOKMARKLET_CODE)
        .then(() => { bmCopy.textContent = '✅ Copiado'; setTimeout(() => { bmCopy.textContent = 'Copiar código'; }, 2000); })
        .catch(() => { bmCode.select(); document.execCommand('copy'); });
    });
  }

  scanEmbeds();
});

// ────────────────────────────────────────────────────────────────────────
// Scan + Debug
// ────────────────────────────────────────────────────────────────────────
async function debugIframes() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DEBUG_IFRAMES' });
    if (res?.iframes?.length) {
      log('🔍 Iframes en página ('+res.iframes.length+'):');
      res.iframes.forEach((f,i) => log('  ['+i+'] src="'+(f.src||f.dataSrc||'sin-src')+'" id="'+f.id+'" class="'+f.className+'"'));
    } else {
      log('⚠ No hay iframes en la página.');
    }
  } catch(e) { log('⚠ Debug error: '+e.message); }
}

async function scanEmbeds(retry) {
  retry = retry || 0;
  setStatus(retry > 0 ? 'Reintentando ('+retry+'/4)…' : 'Escaneando…');
  log('🔍 Escaneando'+(retry > 0 ? ' intento '+(retry+1) : '')+'…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_EMBEDS' });
    if (!res?.ok) {
      setStatus(res?.message || 'Error.', '#fca5a5');
      log('❌ ' + (res?.message || 'Sin respuesta.'));
      return;
    }
    const embeds = res.embeds || [];
    if (!embeds.length) {
      if (retry < 4) {
        const delay = (retry+1)*1000;
        setStatus('Sin videos, reintentando en '+(delay/1000)+'s…', '#f59e0b');
        setTimeout(() => scanEmbeds(retry+1), delay);
        return;
      }
      setStatus('Sin iframes Vimeo detectados.', '#94a3b8');
      log('ℹ Sin videos Vimeo encontrados. Mostrando diagnóstico de iframes…');
      await debugIframes();
      return;
    }
    setStatus(embeds.length+' video(s) encontrado(s).', '#86efac');
    log('✅ '+embeds.length+' video(s). Estrategias: '+[...new Set(embeds.map(e=>e.strategy))].join(', '));
    videosEl.innerHTML = '';
    embeds.forEach(e => renderCard(e, res.tabId, res.pageUrl));
  } catch(err) {
    setStatus('Error: '+err.message, '#fca5a5');
    log('❌ '+err.message);
  }
}

// ────────────────────────────────────────────────────────────────────────
// renderCard  — MEJORADO con título real + cmd FFmpeg para HLS
// ────────────────────────────────────────────────────────────────────────
function strategyTag(strategy) {
  const map = {
    'dom':         { label:'DOM',         cls:'green' },
    'html-regex':  { label:'HTML',         cls:'' },
    'interceptor': { label:'Interceptor',  cls:'green' },
    'postMessage': { label:'postMessage',  cls:'green' },
  };
  return map[strategy] || { label: strategy || '?', cls:'gray' };
}

function renderCard(embed, tabId, pageUrl) {
  const card = document.createElement('div');
  card.className = 'card';
  const vid = embed.vimeoId || '?';

  // ── MEJORA 3: título real desde config o embed ──
  const rawTitle = embed.config?.video?.title || embed.title || '';
  const cleanTitle = safeTitle(rawTitle, 'vimeo-' + vid);

  const titleEl = document.createElement('div');
  titleEl.className = 'title';
  titleEl.textContent = rawTitle || ('Video ' + vid);
  card.appendChild(titleEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'meta';
  metaEl.textContent = 'ID: ' + vid + ' · ' + (embed.strategy || '?');
  card.appendChild(metaEl);

  // ── MEJORA 2: detectar candidatos desde el config capturado ──
  let candidates = [];
  if (embed.config) {
    candidates = extractCandidates(embed.config);
  }
  const hasMp4 = candidates.some(c => c.type !== 'hls');
  const hasHls  = candidates.some(c => c.type === 'hls');

  const tags = document.createElement('div');
  tags.className = 'tags';
  const st = strategyTag(embed.strategy);
  const t0 = document.createElement('span'); t0.className='tag '+(st.cls||''); t0.textContent=st.label; tags.appendChild(t0);
  if (hasMp4 || embed.hasProgressiveFiles) { const t=document.createElement('span'); t.className='tag green'; t.textContent='MP4'; tags.appendChild(t); }
  if (hasHls  || embed.hasHls)  { const t=document.createElement('span'); t.className='tag'; t.textContent='HLS'; tags.appendChild(t); }
  if (embed.hasDash) { const t=document.createElement('span'); t.className='tag'; t.textContent='DASH'; tags.appendChild(t); }
  if (!embed.configFound && !embed.config) { const t=document.createElement('span'); t.className='tag gray'; t.textContent='sin config aún'; tags.appendChild(t); }
  card.appendChild(tags);

  const field = document.createElement('div'); field.className = 'field';
  const lbl = document.createElement('label'); lbl.textContent = 'Nombre de archivo:';
  field.appendChild(lbl);
  const nameInput = document.createElement('input');
  nameInput.type  = 'text';
  nameInput.value = cleanTitle;                   // título real limpio
  nameInput.placeholder = 'nombre-sin-extension';
  field.appendChild(nameInput);
  card.appendChild(field);

  // ── MEJORA 2: comando FFmpeg si el único formato disponible es HLS ──
  if (hasHls && !hasMp4) {
    const hlsCandidate = candidates.find(c => c.type === 'hls');
    if (hlsCandidate) {
      const ffmpegBox = document.createElement('div');
      ffmpegBox.className = 'ffmpeg-box';

      const ffmpegLbl = document.createElement('div');
      ffmpegLbl.className = 'ffmpeg-label';
      ffmpegLbl.textContent = '🖥 Comando FFmpeg (alternativa manual):';
      ffmpegBox.appendChild(ffmpegLbl);

      const ffmpegCmd = document.createElement('textarea');
      ffmpegCmd.className = 'ffmpeg-cmd';
      ffmpegCmd.readOnly  = true;
      ffmpegCmd.rows      = 2;
      // El valor se actualiza si el usuario cambia el nombre
      function updateFfmpegCmd() {
        const fname = (nameInput.value.trim() || cleanTitle || 'video-vimeo').replace(/\.mp4$/i, '');
        ffmpegCmd.value = `ffmpeg -i "${hlsCandidate.url}" -c copy "${fname}.mp4"`;
      }
      updateFfmpegCmd();
      nameInput.addEventListener('input', updateFfmpegCmd);
      ffmpegBox.appendChild(ffmpegCmd);

      const copyFfmpeg = document.createElement('button');
      copyFfmpeg.className = 'small';
      copyFfmpeg.textContent = 'Copiar comando';
      copyFfmpeg.addEventListener('click', () => {
        navigator.clipboard.writeText(ffmpegCmd.value)
          .then(() => { copyFfmpeg.textContent = '✅ Copiado'; setTimeout(() => { copyFfmpeg.textContent = 'Copiar comando'; }, 2000); })
          .catch(() => { ffmpegCmd.select(); document.execCommand('copy'); });
        log('📋 Cmd FFmpeg copiado para "' + (nameInput.value || cleanTitle) + '"');
      });
      ffmpegBox.appendChild(copyFfmpeg);
      card.appendChild(ffmpegBox);
    }
  }

  const actions = document.createElement('div'); actions.className = 'actions';

  // ── Botón Descargar ──
  const btnDl = document.createElement('button');
  btnDl.className = 'primary';
  btnDl.textContent = '⬇ Descargar';
  btnDl.addEventListener('click', async () => {
    if (btnDl.getAttribute('data-state') === 'loading') return;
    btnState(btnDl, 'loading', '⏳ Descargando…');
    // Usar el nombre limpio del input
    const preferredName = safeTitle(nameInput.value.trim(), cleanTitle);
    log('⬇ ID '+vid+' iniciando…');
    try {
      await chrome.runtime.sendMessage({ type:'INJECT_FLOATER' });
      await chrome.tabs.sendMessage(tabId, {
        type:'FLOATER_START', videoId:String(vid), title: preferredName
      }).catch(()=>{});
      const res = await chrome.runtime.sendMessage({
        type:'TRY_DOWNLOAD',
        payload: { vimeoId:String(vid), tabId, pageUrl, preferredName }
      });
      if (res?.converting) {
        log('⏳ HLS→MP4: '+res.title);
        const r2 = await chrome.runtime.sendMessage({
          type:'CONVERT_HLS',
          payload: { hlsUrl:res.hlsUrl, title:res.title, referer:pageUrl, tabId, videoId:String(vid) }
        });
        if (r2?.ok) { btnState(btnDl,'ok','✅ Listo'); log('✅ '+(r2.message||'Completado.')); }
        else         { btnState(btnDl,'err','❌ Error'); log('❌ '+(r2?.message||'Error HLS.')); }
      } else if (res?.ok) {
        btnState(btnDl,'ok','✅ Listo');
        log('✅ '+(res.message||'Descarga iniciada.'));
      } else {
        btnState(btnDl,'err','❌ Error');
        log('❌ '+(res?.message||'Sin respuesta.'));
        if (res?.oembed) log('ℹ oEmbed: '+res.oembed.title+' por '+res.oembed.author_name);
      }
    } catch(err) {
      btnState(btnDl,'err','❌ Error');
      log('❌ Excepción: '+err.message);
    }
  });
  actions.appendChild(btnDl);

  // ── Botón Diagnóstico ──
  const btnDiag = document.createElement('button');
  btnDiag.className = 'sec';
  btnDiag.textContent = '🔍 Diagnóstico';
  btnDiag.addEventListener('click', async () => {
    btnDiag.textContent = '…';
    try {
      const res = await chrome.runtime.sendMessage({
        type:'DIAGNOSE_VIDEO',
        payload: { vimeoId:String(vid), tabId, pageUrl }
      });
      log(res?.message || JSON.stringify(res));
    } catch(e) { log('❌ '+e.message); }
    btnDiag.textContent = '🔍 Diagnóstico';
  });
  actions.appendChild(btnDiag);

  // ── Botón Config RAW ──
  const btnCfg = document.createElement('button');
  btnCfg.className = 'purple sm';
  btnCfg.textContent = '⚙ Config';
  btnCfg.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type:'GET_RAW_CONFIG', payload:{ tabId, vimeoId:String(vid) } });
      if (res?.ok) {
        log('Fuente: '+res.source+' | Keys: '+res.filesKeys.join(', '));
        log('Título: '+res.videoTitle+' | Candidatos: '+res.candidates.length);
        res.candidates.forEach((c,i) => log('  ['+i+'] '+c.source+' '+c.quality+' '+Math.round((c.size||0)/1024/1024)+'MB'));
        // Si el título viene en el config, actualizar el input
        if (res.videoTitle) nameInput.value = safeTitle(res.videoTitle, cleanTitle);
      } else { log('❌ '+(res?.message||'Sin config.')); }
    } catch(e) { log('❌ '+e.message); }
  });
  actions.appendChild(btnCfg);

  card.appendChild(actions);
  videosEl.appendChild(card);
}
