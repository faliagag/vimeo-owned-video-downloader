/* popup.js v9.0 */
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

// Cargar host guardado
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

// Escuchar progreso
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CONVERT_PROGRESS') {
    const pct = msg.pct >= 0 ? ' ['+msg.pct+'%]' : '';
    log(pct + ' ' + (msg.message || ''));
    setStatus((msg.message||'')+pct,
      msg.pct >= 100 ? '#86efac' : msg.pct < 0 ? '#fca5a5' : '#93c5fd');
  }
});

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

function strategyTag(strategy) {
  const map = {
    'dom':         { label:'DOM', cls:'green' },
    'html-regex':  { label:'HTML', cls:'' },
    'interceptor': { label:'Interceptor', cls:'green' },
  };
  return map[strategy] || { label: strategy, cls:'gray' };
}

function renderCard(embed, tabId, pageUrl) {
  const card = document.createElement('div');
  card.className = 'card';
  const vid = embed.vimeoId || '?';

  const titleEl = document.createElement('div');
  titleEl.className = 'title';
  titleEl.textContent = embed.title || ('Video ' + vid);
  card.appendChild(titleEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'meta';
  metaEl.textContent = 'ID: ' + vid + ' · ' + (embed.strategy||'?');
  card.appendChild(metaEl);

  const tags = document.createElement('div');
  tags.className = 'tags';
  const st = strategyTag(embed.strategy);
  const t0 = document.createElement('span'); t0.className='tag '+(st.cls||''); t0.textContent=st.label; tags.appendChild(t0);
  if (embed.hasProgressiveFiles) { const t=document.createElement('span'); t.className='tag green'; t.textContent='MP4'; tags.appendChild(t); }
  if (embed.hasHls)  { const t=document.createElement('span'); t.className='tag'; t.textContent='HLS'; tags.appendChild(t); }
  if (embed.hasDash) { const t=document.createElement('span'); t.className='tag'; t.textContent='DASH'; tags.appendChild(t); }
  if (!embed.configFound) { const t=document.createElement('span'); t.className='tag gray'; t.textContent='sin config aún'; tags.appendChild(t); }
  card.appendChild(tags);

  const field = document.createElement('div'); field.className = 'field';
  const lbl = document.createElement('label'); lbl.textContent = 'Nombre de archivo:';
  field.appendChild(lbl);
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = embed.title || ('vimeo-'+vid);
  nameInput.placeholder = 'nombre-sin-extension';
  field.appendChild(nameInput);
  card.appendChild(field);

  const actions = document.createElement('div'); actions.className = 'actions';

  // ── Botón Descargar ──
  const btnDl = document.createElement('button');
  btnDl.className = 'primary';
  btnDl.textContent = '⬇ Descargar';
  btnDl.addEventListener('click', async () => {
    if (btnDl.getAttribute('data-state') === 'loading') return;
    btnState(btnDl, 'loading', '⏳ Descargando…');
    log('⬇ ID '+vid+' iniciando…');
    try {
      await chrome.runtime.sendMessage({ type:'INJECT_FLOATER' });
      await chrome.tabs.sendMessage(tabId, {
        type:'FLOATER_START', videoId:String(vid),
        title: nameInput.value || embed.title || ('Video '+vid)
      }).catch(()=>{});
      const res = await chrome.runtime.sendMessage({
        type:'TRY_DOWNLOAD',
        payload: { vimeoId:String(vid), tabId, pageUrl, preferredName: nameInput.value || embed.title }
      });
      if (res?.converting) {
        log('⏳ HLS: '+res.title);
        const r2 = await chrome.runtime.sendMessage({
          type:'CONVERT_HLS',
          payload: { hlsUrl:res.hlsUrl, title:res.title, referer:pageUrl, tabId, videoId:String(vid) }
        });
        if (r2?.ok) { btnState(btnDl,'ok','✅ Listo'); log('✅ '+(r2.message||'Completado.')); }
        else { btnState(btnDl,'err','❌ Error'); log('❌ '+(r2?.message||'Error HLS.')); }
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
      } else { log('❌ '+(res?.message||'Sin config.')); }
    } catch(e) { log('❌ '+e.message); }
  });
  actions.appendChild(btnCfg);

  card.appendChild(actions);
  videosEl.appendChild(card);
}

document.addEventListener('DOMContentLoaded', () => scanEmbeds());
