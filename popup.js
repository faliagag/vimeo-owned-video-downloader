/* popup.js v8.5
 * - Retry automático al escanear (3 intentos con delay)
 * - Log de todos los iframes encontrados para diagnóstico
 * - Botón Reescanear siempre visible
 */
'use strict';

const $ = id => document.getElementById(id);
const statusEl = $('status');
const videosEl = $('videos');
const logEl    = $('log');

let sessionLog = [];

function log(msg) {
  const t = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  sessionLog.push('[' + t + '] ' + msg);
  if (sessionLog.length > 120) sessionLog.shift();
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

// Cargar dominio guardado
chrome.storage.local.get(['allowedHost'], ({ allowedHost }) => {
  if (allowedHost) {
    $('allowedHost').value = allowedHost;
    $('hostInfo').textContent = 'Dominio: ' + allowedHost;
  }
});

$('saveHost').addEventListener('click', () => {
  const val = $('allowedHost').value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!val) { log('⚠ Ingresa un dominio válido.'); return; }
  chrome.storage.local.set({ allowedHost: val }, () => {
    $('hostInfo').textContent = 'Dominio: ' + val;
    log('✅ Dominio guardado: ' + val);
  });
});

$('clearLog').addEventListener('click', () => {
  sessionLog = [];
  logEl.textContent = 'Sin actividad.';
});

$('refresh').addEventListener('click', () => scanEmbeds());

// Escuchar progreso desde background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CONVERT_PROGRESS') {
    const pct = msg.pct >= 0 ? ' [' + msg.pct + '%]' : '';
    log(pct + ' ' + (msg.message || ''));
    setStatus((msg.message || '') + pct, msg.pct >= 100 ? '#86efac' : msg.pct < 0 ? '#fca5a5' : '#93c5fd');
  }
});

// Diagnóstico de iframes en la página
async function debugIframes() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DEBUG_IFRAMES' });
    if (res?.iframes?.length) {
      log('🔍 Iframes en página (' + res.iframes.length + '):');
      res.iframes.forEach((f, i) => log('  [' + i + '] ' + (f.src || f.dataSrc || 'sin-src') + ' | ' + (f.className || '')));
    } else {
      log('⚠ No hay ningún iframe en la página.');
    }
  } catch(e) { log('⚠ Debug: ' + e.message); }
}

async function scanEmbeds(retry) {
  retry = retry || 0;
  if (retry === 0) videosEl.innerHTML = '';
  setStatus(retry > 0 ? 'Reintentando (' + retry + '/3)…' : 'Escaneando…');
  log('🔍 Escaneando iframes Vimeo' + (retry > 0 ? ' (intento ' + (retry + 1) + ')' : '') + '…');

  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_EMBEDS' });
    if (!res?.ok) {
      setStatus(res?.message || 'Error.', '#fca5a5');
      log('❌ ' + (res?.message || 'Sin respuesta.'));
      return;
    }

    const embeds = res.embeds || [];

    if (!embeds.length) {
      if (retry < 3) {
        // Reintentar con delay creciente
        const delay = (retry + 1) * 800;
        setStatus('Sin resultados, reintentando en ' + (delay / 1000).toFixed(1) + 's…', '#f59e0b');
        setTimeout(() => scanEmbeds(retry + 1), delay);
        return;
      }
      setStatus('Sin iframes Vimeo detectados.', '#94a3b8');
      log('ℹ Sin iframes Vimeo. Ejecutando diagnóstico…');
      await debugIframes();
      return;
    }

    setStatus(embeds.length + ' video(s) detectado(s).', '#86efac');
    log('✅ ' + embeds.length + ' video(s) encontrado(s).');
    videosEl.innerHTML = '';
    embeds.forEach(e => renderCard(e, res.tabId, res.pageUrl));
  } catch (err) {
    setStatus('Error: ' + err.message, '#fca5a5');
    log('❌ ' + err.message);
  }
}

function renderCard(embed, tabId, pageUrl) {
  const card = document.createElement('div');
  card.className = 'card';
  const vid = embed.vimeoId || embed.id || '?';

  const titleEl = document.createElement('div');
  titleEl.className = 'title';
  titleEl.textContent = embed.title || ('Video ' + vid);
  card.appendChild(titleEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'meta';
  metaEl.textContent = 'ID: ' + vid + (embed.src ? ' · ' + embed.src.slice(0, 60) + '…' : '');
  card.appendChild(metaEl);

  const tags = document.createElement('div');
  tags.className = 'tags';
  if (embed.hasProgressiveFiles) {
    const t = document.createElement('span'); t.className = 'tag blue'; t.textContent = 'MP4 directo'; tags.appendChild(t);
  }
  if (embed.hasHls) {
    const t = document.createElement('span'); t.className = 'tag blue'; t.textContent = 'HLS'; tags.appendChild(t);
  }
  if (!embed.configFound) {
    const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'sin config aún'; tags.appendChild(t);
  }
  card.appendChild(tags);

  const field = document.createElement('div');
  field.className = 'field';
  const lbl = document.createElement('label');
  lbl.textContent = 'Nombre de archivo:';
  field.appendChild(lbl);
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = embed.title || ('vimeo-' + vid);
  nameInput.placeholder = 'nombre-sin-extension';
  field.appendChild(nameInput);
  card.appendChild(field);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const btnDl = document.createElement('button');
  btnDl.textContent = '⬇ Descargar';
  btnDl.setAttribute('data-vid', String(vid));
  btnDl.addEventListener('click', async () => {
    if (btnDl.getAttribute('data-state') === 'loading') return;
    btnState(btnDl, 'loading', '⏳ Descargando…');
    log('⬇ Iniciando descarga ID ' + vid + '…');
    try {
      await chrome.runtime.sendMessage({ type: 'INJECT_FLOATER' });
      await chrome.tabs.sendMessage(tabId, {
        type: 'FLOATER_START',
        videoId: String(vid),
        title: nameInput.value || embed.title || ('Video ' + vid)
      }).catch(() => {});

      const res = await chrome.runtime.sendMessage({
        type: 'TRY_DOWNLOAD',
        payload: { vimeoId: String(vid), tabId, pageUrl, preferredName: nameInput.value || embed.title }
      });

      if (res?.converting) {
        log('⏳ Iniciando conversión HLS: ' + res.title);
        const r2 = await chrome.runtime.sendMessage({
          type: 'CONVERT_HLS',
          payload: { hlsUrl: res.hlsUrl, title: res.title, referer: pageUrl, tabId, videoId: String(vid) }
        });
        if (r2?.ok) { btnState(btnDl, 'ok', '✅ Listo'); log('✅ ' + (r2.message || 'Descarga completada.')); }
        else { btnState(btnDl, 'err', '❌ Error'); log('❌ ' + (r2?.message || 'Error HLS.')); }
      } else if (res?.ok) {
        btnState(btnDl, 'ok', '✅ Listo');
        log('✅ ' + (res.message || 'Descarga iniciada.'));
      } else {
        btnState(btnDl, 'err', '❌ Error');
        log('❌ ' + (res?.message || 'Sin respuesta del background.'));
      }
    } catch (err) {
      btnState(btnDl, 'err', '❌ Error');
      log('❌ Excepción: ' + err.message);
    }
  });
  actions.appendChild(btnDl);

  const btnDiag = document.createElement('button');
  btnDiag.className = 'sec';
  btnDiag.textContent = '🔍 Diagnóstico';
  btnDiag.addEventListener('click', async () => {
    btnDiag.textContent = '…';
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'DIAGNOSE_VIDEO',
        payload: { vimeoId: String(vid), tabId, pageUrl }
      });
      log(res?.message || JSON.stringify(res));
    } catch(e) { log('❌ ' + e.message); }
    btnDiag.textContent = '🔍 Diagnóstico';
  });
  actions.appendChild(btnDiag);

  const btnCfg = document.createElement('button');
  btnCfg.className = 'purple sm';
  btnCfg.textContent = '⚙ Config';
  btnCfg.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_RAW_CONFIG', payload: { tabId, vimeoId: String(vid) } });
      if (res?.ok) {
        log('Config keys: ' + (res.filesKeys || []).join(', '));
        log('Candidatos: ' + res.candidates.length + ' | Título: ' + (res.videoTitle || '?'));
        res.candidates.forEach((c, i) => log('  [' + i + '] ' + c.source + ' ' + c.quality + ' ' + Math.round((c.size || 0) / 1024 / 1024) + 'MB'));
      } else { log('❌ ' + (res?.message || 'Sin config.')); }
    } catch(e) { log('❌ ' + e.message); }
  });
  actions.appendChild(btnCfg);

  card.appendChild(actions);
  videosEl.appendChild(card);
}

document.addEventListener('DOMContentLoaded', () => scanEmbeds());
