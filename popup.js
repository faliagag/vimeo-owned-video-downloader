/* popup.js v7.0 */
'use strict';
const statusEl    = document.getElementById('status');
const videosEl    = document.getElementById('videos');
const hostInput   = document.getElementById('allowedHost');
const hostInfo    = document.getElementById('hostInfo');
const saveHostBtn = document.getElementById('saveHost');
const refreshBtn  = document.getElementById('refresh');
const clearLogBtn = document.getElementById('clearLog');
const logEl       = document.getElementById('log');
const progressEl  = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressMsg = document.getElementById('progressMsg');
const tsNoteEl    = document.getElementById('tsNote');

let _tabId = null, _pageUrl = null, _converting = false;

function normalizeHost(v) {
  return (v || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}
async function appendLog(line) {
  const { activityLog } = await chrome.storage.local.get(['activityLog']);
  const next = [`[${new Date().toLocaleTimeString()}] ${line}`, ...(activityLog || [])].slice(0, 200);
  await chrome.storage.local.set({ activityLog: next });
  renderLog(next);
}
function renderLog(list) {
  logEl.textContent = (list?.length) ? list.join('\n') : 'Sin actividad.';
}
async function loadLog() {
  const { activityLog } = await chrome.storage.local.get(['activityLog']);
  renderLog(activityLog || []);
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'CONVERT_PROGRESS') setProgress(msg.message, msg.pct);
});

function setProgress(text, pct) {
  if (!text) { progressEl.style.display = 'none'; return; }
  progressEl.style.display = 'block';
  progressMsg.textContent = text;
  const p = pct >= 0 ? pct : (text.match(/(\d+)%/)?.[1] ? parseInt(text.match(/(\d+)%/)[1]) : -1);
  if (p >= 0) progressBar.style.width = Math.min(p, 100) + '%';
  if (/completad|iniciada/i.test(text)) setTimeout(() => { progressEl.style.display = 'none'; }, 4000);
}

function buildCard(video, idx) {
  const card = document.createElement('div'); card.className = 'card';
  const title = document.createElement('div'); title.className = 'title';
  title.textContent = `${idx + 1}. ${video.titleHint || 'Embed Vimeo'} · ID ${video.vimeoId || '?'}`;
  const meta = document.createElement('div'); meta.className = 'meta';
  meta.textContent = (video.src || '').slice(0, 90);
  const tags = document.createElement('div'); tags.className = 'tags';
  if (video.detectedBy) { const s = document.createElement('span'); s.className = 'tag'; s.textContent = video.detectedBy; tags.appendChild(s); }
  if (video.vimeoId) { const s = document.createElement('span'); s.className = 'tag blue'; s.textContent = 'ID: ' + video.vimeoId; tags.appendChild(s); }
  const nameField = document.createElement('div'); nameField.className = 'field';
  nameField.innerHTML = `<label>Nombre del archivo</label><input type="text" value="${(video.titleHint || 'video-' + video.vimeoId).replace(/"/g, '&quot;')}">` ;
  const filenameInput = nameField.querySelector('input');
  const actions = document.createElement('div'); actions.className = 'actions';

  const btnDl = document.createElement('button');
  btnDl.textContent = '⬇ Descargar';
  btnDl.onclick = async () => {
    if (_converting) { statusEl.textContent = '⏳ Descarga en curso…'; return; }
    statusEl.textContent = 'Preparando…';
    tsNoteEl.style.display = 'none';
    setProgress('Iniciando…', 1);
    const payload = { ...video, tabId: _tabId, pageUrl: _pageUrl, preferredName: filenameInput.value };
    const r = await chrome.runtime.sendMessage({ type: 'TRY_DOWNLOAD', payload });
    if (r.converting && r.hlsUrl) {
      _converting = true;
      statusEl.textContent = r.message;
      appendLog('HLS START · ' + filenameInput.value);
      const cr = await chrome.runtime.sendMessage({
        type: 'CONVERT_HLS',
        payload: { hlsUrl: r.hlsUrl, title: r.title || filenameInput.value, referer: _pageUrl }
      });
      _converting = false;
      setProgress(cr.ok ? '✅ Completado' : null);
      statusEl.textContent = cr.message || '…';
      if (cr.ok) tsNoteEl.style.display = 'block';
      appendLog((cr.ok ? 'HLS OK' : 'HLS ERR') + ' · ' + filenameInput.value + ' · ' + cr.message);
    } else {
      setProgress(null);
      statusEl.textContent = r.message || '…';
      appendLog((r.ok ? 'OK' : 'ERR') + ' · ' + filenameInput.value + ' · ' + r.message);
    }
  };

  const btnDiag = document.createElement('button');
  btnDiag.className = 'sec'; btnDiag.textContent = '🔍 Diagnóstico';
  btnDiag.onclick = async () => {
    statusEl.textContent = 'Diagnosticando…';
    const r = await chrome.runtime.sendMessage({ type: 'DIAGNOSE_VIDEO', payload: { ...video, tabId: _tabId, pageUrl: _pageUrl } });
    statusEl.textContent = r.message || '…';
    appendLog('DIAG · ' + (video.vimeoId || '?') + ' · ' + r.message);
  };

  const btnRaw = document.createElement('button');
  btnRaw.className = 'purple'; btnRaw.textContent = '🔬 Config';
  btnRaw.onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'GET_RAW_CONFIG', payload: { ...video, tabId: _tabId, pageUrl: _pageUrl } });
    if (!r.ok) { statusEl.textContent = r.message; return; }
    const info = 'FILES: [' + r.filesKeys.join(',') + '] | ' + r.candidates.map(c => c.source + ':' + c.quality).join(' | ');
    statusEl.textContent = info;
    appendLog('RAW · ' + (r.videoTitle || video.vimeoId) + ' · ' + info);
  };

  actions.append(btnDl, btnDiag, btnRaw);
  card.append(title, meta, tags, nameField, actions);
  return card;
}

function render(embeds) {
  videosEl.innerHTML = '';
  if (!embeds?.length) { statusEl.textContent = '⚠️ Sin embeds detectados. Recarga la página con la extensión activa.'; return; }
  statusEl.textContent = '✅ ' + embeds.length + ' embed(s) detectado(s).';
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
  statusEl.textContent = '✅ Dominio guardado.';
  appendLog('CONFIG · dominio = ' + h);
});
refreshBtn.addEventListener('click', init);
clearLogBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ activityLog: [] });
  renderLog([]);
});

async function init() {
  await loadHost();
  await loadLog();
  statusEl.textContent = 'Escaneando…';
  const r = await chrome.runtime.sendMessage({ type: 'GET_EMBEDS' });
  if (!r?.ok) { statusEl.textContent = '❌ ' + (r?.message || 'Error.'); return; }
  _tabId = r.tabId; _pageUrl = r.pageUrl;
  render(r.embeds);
}
init();
