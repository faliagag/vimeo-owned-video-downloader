/* popup.js v6.2 */
const statusEl    = document.getElementById('status');
const videosEl    = document.getElementById('videos');
const hostInput   = document.getElementById('allowedHost');
const hostInfo    = document.getElementById('hostInfo');
const saveHostBtn = document.getElementById('saveHost');
const refreshBtn  = document.getElementById('refresh');
const clearLogBtn = document.getElementById('clearLog');
const logEl       = document.getElementById('log');

let _tabId = null;
let _pageUrl = null;

function normalizeHost(v) {
  return (v || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

async function appendLog(line) {
  const { activityLog } = await chrome.storage.local.get(['activityLog']);
  const next = [`[${new Date().toLocaleTimeString()}] ${line}`, ...(activityLog || [])].slice(0, 100);
  await chrome.storage.local.set({ activityLog: next });
  renderLog(next);
}
function renderLog(list) {
  logEl.textContent = list && list.length ? list.join('\n') : 'Sin actividad.';
}
async function loadLog() {
  const { activityLog } = await chrome.storage.local.get(['activityLog']);
  renderLog(activityLog || []);
}

function badge(text, color) {
  const s = document.createElement('span');
  s.className = 'tag';
  s.textContent = text;
  if (color) s.style.background = color;
  return s;
}

function buildCard(video, idx) {
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${idx + 1}. ${video.titleHint || 'Embed Vimeo'} · ID ${video.vimeoId || '?'}`;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = (video.src || '').slice(0, 80);

  const tags = document.createElement('div');
  tags.style.margin = '4px 0';
  if (video.detectedBy) tags.appendChild(badge(video.detectedBy));
  if (video.vimeoId)    tags.appendChild(badge('ID: ' + video.vimeoId, '#dbeafe'));

  const nameField = document.createElement('div');
  nameField.className = 'field';
  nameField.innerHTML = `<label>Nombre archivo</label><input type="text" value="${(video.titleHint || 'video-' + video.vimeoId).replace(/"/g, '&quot;')}">` ;
  const filenameInput = nameField.querySelector('input');

  const qualField = document.createElement('div');
  qualField.className = 'field';
  qualField.innerHTML = `<label>Calidad preferida</label><select>
    <option value="best">Mejor disponible</option>
    <option value="2160">2160p (4K)</option>
    <option value="1080">1080p (Full HD)</option>
    <option value="720">720p (HD)</option>
    <option value="540">540p</option>
    <option value="480">480p</option>
    <option value="360">360p</option>
  </select>`;
  const qualSelect = qualField.querySelector('select');

  const actions = document.createElement('div');
  actions.className = 'actions';

  /* Boton descargar */
  const btnDl = document.createElement('button');
  btnDl.textContent = '⬇ Descargar';
  btnDl.onclick = async () => {
    statusEl.textContent = 'Preparando...';
    const payload = { ...video, tabId: _tabId, pageUrl: _pageUrl, preferredQuality: qualSelect.value, preferredName: filenameInput.value };
    const r = await chrome.runtime.sendMessage({ type: 'TRY_DOWNLOAD', payload });
    statusEl.textContent = r.message || '...';
    appendLog((r.ok ? 'OK' : 'ERR') + ' · ' + filenameInput.value + ' · ' + r.message);
  };

  /* Boton diagnostico */
  const btnDiag = document.createElement('button');
  btnDiag.className = 'secondary';
  btnDiag.textContent = '🔍 Diagnóstico';
  btnDiag.onclick = async () => {
    statusEl.textContent = 'Diagnosticando...';
    const r = await chrome.runtime.sendMessage({ type: 'DIAGNOSE_VIDEO', payload: { ...video, tabId: _tabId, pageUrl: _pageUrl } });
    statusEl.textContent = r.message || '...';
    appendLog('DIAG · ' + (video.vimeoId || '?') + ' · ' + r.message);
  };

  /* Boton inspeccionar config RAW */
  const btnRaw = document.createElement('button');
  btnRaw.className = 'secondary';
  btnRaw.style.background = '#7c3aed';
  btnRaw.textContent = '🔬 Ver config';
  btnRaw.onclick = async () => {
    statusEl.textContent = 'Inspeccionando config...';
    const r = await chrome.runtime.sendMessage({ type: 'GET_RAW_CONFIG', payload: { ...video, tabId: _tabId, pageUrl: _pageUrl } });
    if (!r.ok) {
      statusEl.textContent = r.message;
      appendLog('RAW ERR · ' + r.message);
      return;
    }
    const info = 'CLAVES: ' + r.rawKeys.join(', ') +
      ' | REQUEST: ' + r.requestKeys.join(', ') +
      ' | FILES: ' + r.filesKeys.join(', ') +
      ' | CANDIDATOS: ' + r.candidates.length +
      ' | ' + r.candidates.map(c => '[' + c.source + '] ' + c.quality + (c.height ? 'p' : '') + ' ' + (c.url || '').slice(0, 50)).join(' || ');
    statusEl.textContent = info;
    appendLog('RAW · ' + (r.videoTitle || video.vimeoId) + ' · ' + info);
  };

  actions.append(btnDl, btnDiag, btnRaw);
  card.append(title, meta, tags, nameField, qualField, actions);
  return card;
}

function render(embeds) {
  videosEl.innerHTML = '';
  if (!embeds || !embeds.length) {
    statusEl.textContent = '⚠️ Sin embeds de Vimeo detectados. Recarga la pagina con la extension activa.';
    return;
  }
  statusEl.textContent = `✅ ${embeds.length} embed(s) detectado(s).`;
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
  statusEl.textContent = 'Dominio guardado.';
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
  statusEl.textContent = 'Escaneando...';
  const r = await chrome.runtime.sendMessage({ type: 'GET_EMBEDS' });
  if (!r || !r.ok) {
    statusEl.textContent = '❌ ' + (r && r.message || 'Error al escanear.');
    return;
  }
  _tabId   = r.tabId;
  _pageUrl = r.pageUrl;
  render(r.embeds);
}

init();
