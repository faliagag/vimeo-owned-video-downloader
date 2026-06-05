/* popup.js v6.3 */
const statusEl    = document.getElementById('status');
const videosEl    = document.getElementById('videos');
const hostInput   = document.getElementById('allowedHost');
const hostInfo    = document.getElementById('hostInfo');
const saveHostBtn = document.getElementById('saveHost');
const refreshBtn  = document.getElementById('refresh');
const clearLogBtn = document.getElementById('clearLog');
const logEl       = document.getElementById('log');
const hlsSectionEl= document.getElementById('hlsSection');
const hlsUrlEl    = document.getElementById('hlsUrl');
const hlsTitleEl  = document.getElementById('hlsTitle');
const copyHlsBtn  = document.getElementById('copyHls');

let _tabId = null;
let _pageUrl = null;

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
  logEl.textContent = list && list.length ? list.join('\n') : 'Sin actividad.';
}
async function loadLog() {
  const { activityLog } = await chrome.storage.local.get(['activityLog']);
  renderLog(activityLog || []);
}

async function checkHlsSection() {
  const { lastHlsUrl, lastHlsTitle } = await chrome.storage.local.get(['lastHlsUrl', 'lastHlsTitle']);
  if (lastHlsUrl) {
    hlsSectionEl.style.display = 'block';
    hlsUrlEl.value   = lastHlsUrl;
    hlsTitleEl.value = lastHlsTitle || 'video';
  } else {
    hlsSectionEl.style.display = 'none';
  }
}

if (copyHlsBtn) {
  copyHlsBtn.addEventListener('click', async () => {
    const url = hlsUrlEl.value;
    if (!url) return;
    await navigator.clipboard.writeText(url);
    copyHlsBtn.textContent = '\u2705 Copiado';
    setTimeout(() => { copyHlsBtn.textContent = 'Copiar URL HLS'; }, 2000);
    appendLog('COPY HLS · ' + url.slice(0, 80));
  });
}

function buildCard(video, idx) {
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${idx + 1}. ${video.titleHint || 'Embed Vimeo'} \u00b7 ID ${video.vimeoId || '?'}`;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = (video.src || '').slice(0, 80);

  const tags = document.createElement('div');
  tags.style.margin = '4px 0';
  if (video.detectedBy) { const s = document.createElement('span'); s.className = 'tag'; s.textContent = video.detectedBy; tags.appendChild(s); }
  if (video.vimeoId)    { const s = document.createElement('span'); s.className = 'tag'; s.textContent = 'ID: ' + video.vimeoId; s.style.background = '#dbeafe'; tags.appendChild(s); }

  const nameField = document.createElement('div');
  nameField.className = 'field';
  nameField.innerHTML = `<label>Nombre archivo</label><input type="text" value="${(video.titleHint || 'video-' + video.vimeoId).replace(/"/g, '&quot;')}">`;
  const filenameInput = nameField.querySelector('input');

  const qualField = document.createElement('div');
  qualField.className = 'field';
  qualField.innerHTML = `<label>Calidad preferida</label><select>
    <option value="best">Mejor disponible</option>
    <option value="1080">1080p</option>
    <option value="720">720p</option>
    <option value="480">480p</option>
    <option value="360">360p</option>
  </select>`;
  const qualSelect = qualField.querySelector('select');

  const actions = document.createElement('div');
  actions.className = 'actions';

  /* Descargar */
  const btnDl = document.createElement('button');
  btnDl.textContent = '\u2b07 Descargar';
  btnDl.onclick = async () => {
    statusEl.textContent = 'Preparando...';
    const payload = { ...video, tabId: _tabId, pageUrl: _pageUrl, preferredQuality: qualSelect.value, preferredName: filenameInput.value };
    const r = await chrome.runtime.sendMessage({ type: 'TRY_DOWNLOAD', payload });
    statusEl.textContent = r.message || '...';
    if (r.needsHelper && r.hlsUrl) {
      await chrome.storage.local.set({ lastHlsUrl: r.hlsUrl, lastHlsTitle: filenameInput.value });
      await checkHlsSection();
      statusEl.textContent = '\u26a0\ufe0f HLS detectado. Copia la URL y usa yt-dlp (ver instrucciones abajo).';
    }
    appendLog((r.ok ? 'OK' : r.needsHelper ? 'HLS' : 'ERR') + ' \u00b7 ' + filenameInput.value + ' \u00b7 ' + r.message);
  };

  /* Diagnostico */
  const btnDiag = document.createElement('button');
  btnDiag.className = 'secondary';
  btnDiag.textContent = '\ud83d\udd0d Diagn\u00f3stico';
  btnDiag.onclick = async () => {
    statusEl.textContent = 'Diagnosticando...';
    const r = await chrome.runtime.sendMessage({ type: 'DIAGNOSE_VIDEO', payload: { ...video, tabId: _tabId, pageUrl: _pageUrl } });
    statusEl.textContent = r.message || '...';
    appendLog('DIAG \u00b7 ' + (video.vimeoId || '?') + ' \u00b7 ' + r.message);
  };

  /* Config RAW */
  const btnRaw = document.createElement('button');
  btnRaw.className = 'secondary';
  btnRaw.style.background = '#7c3aed';
  btnRaw.textContent = '\ud83d\udd2c Ver config';
  btnRaw.onclick = async () => {
    statusEl.textContent = 'Inspeccionando...';
    const r = await chrome.runtime.sendMessage({ type: 'GET_RAW_CONFIG', payload: { ...video, tabId: _tabId, pageUrl: _pageUrl } });
    if (!r.ok) { statusEl.textContent = r.message; appendLog('RAW ERR \u00b7 ' + r.message); return; }
    const info = 'CLAVES: ' + r.rawKeys.join(', ') + ' | FILES: ' + r.filesKeys.join(', ') + ' | CANDIDATOS: ' + r.candidates.length + ' | ' + r.candidates.map(c => '[' + c.source + '] ' + c.quality + (c.height ? 'p' : '') + ' ' + (c.url || '').slice(0, 50)).join(' || ');
    statusEl.textContent = info;
    appendLog('RAW \u00b7 ' + (r.videoTitle || video.vimeoId) + ' \u00b7 ' + info);
    /* Si hay HLS, guardarlo automaticamente */
    const hlsCand = r.candidates.find(c => c.source === 'hls');
    if (hlsCand) {
      await chrome.storage.local.set({ lastHlsUrl: hlsCand.url, lastHlsTitle: filenameInput.value });
      await checkHlsSection();
    }
  };

  actions.append(btnDl, btnDiag, btnRaw);
  card.append(title, meta, tags, nameField, qualField, actions);
  return card;
}

function render(embeds) {
  videosEl.innerHTML = '';
  if (!embeds || !embeds.length) {
    statusEl.textContent = '\u26a0\ufe0f Sin embeds detectados. Recarga la pagina.';
    return;
  }
  statusEl.textContent = `\u2705 ${embeds.length} embed(s) detectado(s).`;
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
  appendLog('CONFIG \u00b7 dominio = ' + h);
});

refreshBtn.addEventListener('click', init);
clearLogBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ activityLog: [], lastHlsUrl: null });
  renderLog([]);
  hlsSectionEl.style.display = 'none';
});

async function init() {
  await loadHost();
  await loadLog();
  await checkHlsSection();
  statusEl.textContent = 'Escaneando...';
  const r = await chrome.runtime.sendMessage({ type: 'GET_EMBEDS' });
  if (!r || !r.ok) { statusEl.textContent = '\u274c ' + (r && r.message || 'Error al escanear.'); return; }
  _tabId   = r.tabId;
  _pageUrl = r.pageUrl;
  render(r.embeds);
}

init();
