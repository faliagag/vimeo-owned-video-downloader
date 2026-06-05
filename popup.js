/* popup.js v8.1 */
'use strict';
const statusEl    = document.getElementById('status');
const videosEl    = document.getElementById('videos');
const hostInput   = document.getElementById('allowedHost');
const hostInfo    = document.getElementById('hostInfo');
const saveHostBtn = document.getElementById('saveHost');
const refreshBtn  = document.getElementById('refresh');
const clearLogBtn = document.getElementById('clearLog');
const logEl       = document.getElementById('log');

let _tabId = null, _pageUrl = null;

function normalizeHost(v) { return (v || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase(); }
async function appendLog(line) {
  const { activityLog } = await chrome.storage.local.get(['activityLog']);
  const next = [`[${new Date().toLocaleTimeString()}] ${line}`, ...(activityLog || [])].slice(0, 200);
  await chrome.storage.local.set({ activityLog: next });
  renderLog(next);
}
function renderLog(list) { logEl.textContent = list?.length ? list.join('\n') : 'Sin actividad.'; }
async function loadLog() { const { activityLog } = await chrome.storage.local.get(['activityLog']); renderLog(activityLog || []); }
function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return (s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function buildCard(video, idx) {
  const card = document.createElement('div'); card.className = 'card';
  card.innerHTML = `
    <div class="title">${idx + 1}. ${escHtml(video.titleHint || 'Embed Vimeo')} &middot; ID ${video.vimeoId || '?'}</div>
    <div class="meta">${escHtml((video.src || '').slice(0, 90))}</div>
    <div class="tags">
      <span class="tag">${escHtml(video.detectedBy || '')}</span>
      <span class="tag blue">ID: ${video.vimeoId || '?'}</span>
    </div>
    <div class="field"><label>Nombre del archivo</label>
      <input type="text" value="${escAttr(video.titleHint || 'video-' + video.vimeoId)}">
    </div>
    <div class="actions"></div>
  `;
  const filenameInput = card.querySelector('input');
  const actions = card.querySelector('.actions');

  const btnDl = document.createElement('button');
  btnDl.textContent = '\u2b07 Descargar';
  btnDl.onclick = async () => {
    statusEl.textContent = 'Iniciando\u2026';
    // FIX: inyectar floater una sola vez
    await chrome.runtime.sendMessage({ type: 'INJECT_FLOATER' });
    // Crear la tarjeta flotante UNA vez con el videoId correcto
    if (_tabId) chrome.tabs.sendMessage(_tabId, {
      type: 'FLOATER_START',
      videoId: video.vimeoId,
      title: filenameInput.value
    }).catch(() => {});

    const payload = { ...video, tabId: _tabId, pageUrl: _pageUrl, preferredName: filenameInput.value };
    const r = await chrome.runtime.sendMessage({ type: 'TRY_DOWNLOAD', payload });
    statusEl.textContent = r.message || '\u2026';
    appendLog((r.ok ? 'OK' : 'ERR') + ' \u00b7 ' + filenameInput.value + ' \u00b7 ' + r.message);

    if (r.converting && r.hlsUrl) {
      statusEl.textContent = '\u23f3 Descargando en segundo plano. Puedes cerrar este popup.';
      // FIX: pasar videoId explicitamente
      chrome.runtime.sendMessage({
        type: 'CONVERT_HLS',
        payload: {
          hlsUrl: r.hlsUrl,
          title: r.title || filenameInput.value,
          referer: _pageUrl,
          tabId: _tabId,
          videoId: video.vimeoId
        }
      }).then(cr => {
        if (_tabId) chrome.tabs.sendMessage(_tabId, {
          type: cr?.ok ? 'FLOATER_DONE' : 'FLOATER_ERROR',
          videoId: video.vimeoId,
          title: filenameInput.value,
          message: cr?.message
        }).catch(() => {});
        appendLog((cr?.ok ? 'HLS OK' : 'HLS ERR') + ' \u00b7 ' + filenameInput.value + ' \u00b7 ' + cr?.message);
      });
    } else if (r.ok) {
      if (_tabId) chrome.tabs.sendMessage(_tabId, { type: 'FLOATER_DONE', videoId: video.vimeoId, title: filenameInput.value, message: r.message }).catch(() => {});
    } else {
      if (_tabId) chrome.tabs.sendMessage(_tabId, { type: 'FLOATER_ERROR', videoId: video.vimeoId, title: filenameInput.value, message: r.message }).catch(() => {});
    }
  };

  const btnDiag = document.createElement('button');
  btnDiag.className = 'sec'; btnDiag.textContent = '\ud83d\udd0d Diagn\u00f3stico';
  btnDiag.onclick = async () => {
    statusEl.textContent = 'Diagnosticando\u2026';
    const r = await chrome.runtime.sendMessage({ type: 'DIAGNOSE_VIDEO', payload: { ...video, tabId: _tabId, pageUrl: _pageUrl } });
    statusEl.textContent = r.message || '\u2026';
    appendLog('DIAG \u00b7 ' + (video.vimeoId || '?') + ' \u00b7 ' + r.message);
  };

  const btnRaw = document.createElement('button');
  btnRaw.className = 'purple'; btnRaw.textContent = '\ud83d\udd2c Config';
  btnRaw.onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'GET_RAW_CONFIG', payload: { ...video, tabId: _tabId, pageUrl: _pageUrl } });
    if (!r.ok) { statusEl.textContent = r.message; return; }
    const info = '[' + r.filesKeys.join(',') + '] ' + r.candidates.map(c => c.source + ':' + c.quality).join(' | ');
    statusEl.textContent = info;
    appendLog('RAW \u00b7 ' + (r.videoTitle || video.vimeoId) + ' \u00b7 ' + info);
  };

  actions.append(btnDl, btnDiag, btnRaw);
  return card;
}

function render(embeds) {
  videosEl.innerHTML = '';
  if (!embeds?.length) { statusEl.textContent = '\u26a0\ufe0f Sin embeds detectados. Recarga la p\u00e1gina con la extensi\u00f3n activa.'; return; }
  statusEl.textContent = '\u2705 ' + embeds.length + ' embed(s) detectado(s).';
  embeds.forEach((v, i) => videosEl.appendChild(buildCard(v, i)));
}

async function loadHost() {
  const { allowedHost } = await chrome.storage.local.get(['allowedHost']);
  hostInput.value = allowedHost || '';
  hostInfo.textContent = 'Dominio: ' + (allowedHost || 'sin configurar');
}
saveHostBtn.addEventListener('click', async () => {
  const h = normalizeHost(hostInput.value);
  await chrome.storage.local.set({ allowedHost: h });
  hostInfo.textContent = 'Dominio: ' + (h || 'sin configurar');
  statusEl.textContent = '\u2705 Dominio guardado.';
  appendLog('CONFIG \u00b7 dominio = ' + h);
});
refreshBtn.addEventListener('click', init);
clearLogBtn.addEventListener('click', async () => { await chrome.storage.local.set({ activityLog: [] }); renderLog([]); });

async function init() {
  await loadHost(); await loadLog();
  statusEl.textContent = 'Escaneando\u2026';
  const r = await chrome.runtime.sendMessage({ type: 'GET_EMBEDS' });
  if (!r?.ok) { statusEl.textContent = '\u274c ' + (r?.message || 'Error.'); return; }
  _tabId = r.tabId; _pageUrl = r.pageUrl;
  render(r.embeds);
}
init();
