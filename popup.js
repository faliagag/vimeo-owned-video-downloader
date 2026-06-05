/* popup.js v6.4 */
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

let _tabId = null;
let _pageUrl = null;
let _converting = false;

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

/* Escuchar progreso de conversion desde background */
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg && msg.type === 'CONVERT_PROGRESS') {
    setProgress(msg.message);
  }
});

function setProgress(text) {
  if (!text) { progressEl.style.display = 'none'; return; }
  progressEl.style.display = 'block';
  progressMsg.textContent = text;
  /* Estimar porcentaje desde el texto */
  var pct = 0;
  var m = text.match(/(\d+)%/);
  if (m) pct = parseInt(m[1]);
  else if (/listo|completada|descarga/i.test(text)) pct = 100;
  else if (/convirtiendo ts/i.test(text)) pct = 80;
  else if (/segmentos descargados/i.test(text)) pct = 65;
  else if (/segmento (\d+)\/(\d+)/i.test(text)) {
    var sm = text.match(/segmento (\d+)\/(\d+)/i);
    if (sm) pct = Math.round(parseInt(sm[1]) / parseInt(sm[2]) * 60);
  } else if (/manifiesto|variante/i.test(text)) pct = 5;
  else if (/cargando ffmpeg/i.test(text)) pct = 2;
  progressBar.style.width = pct + '%';
  if (pct === 100) {
    setTimeout(function() { progressEl.style.display = 'none'; }, 3000);
  }
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
  nameField.innerHTML = `<label>Nombre del archivo</label><input type="text" value="${(video.titleHint || 'video-' + video.vimeoId).replace(/"/g, '&quot;')}">` ;
  const filenameInput = nameField.querySelector('input');

  const actions = document.createElement('div');
  actions.className = 'actions';

  /* Boton principal: Descargar / Convertir */
  const btnDl = document.createElement('button');
  btnDl.textContent = '\u2b07 Descargar / Convertir';
  btnDl.onclick = async () => {
    if (_converting) { statusEl.textContent = '\u23f3 Ya hay una conversion en curso...'; return; }
    statusEl.textContent = 'Preparando...';
    const payload = { ...video, tabId: _tabId, pageUrl: _pageUrl, preferredName: filenameInput.value };
    const r = await chrome.runtime.sendMessage({ type: 'TRY_DOWNLOAD', payload });

    if (r.converting && r.hlsUrl) {
      /* Iniciar conversion HLS en offscreen */
      _converting = true;
      statusEl.textContent = r.message;
      setProgress('Iniciando...');
      appendLog('CONV START \u00b7 ' + filenameInput.value);
      const cr = await chrome.runtime.sendMessage({
        type: 'CONVERT_HLS',
        payload: { hlsUrl: r.hlsUrl, title: r.title || filenameInput.value, referer: _pageUrl }
      });
      _converting = false;
      setProgress(cr.ok ? cr.message : null);
      statusEl.textContent = cr.message || '...';
      appendLog((cr.ok ? 'CONV OK' : 'CONV ERR') + ' \u00b7 ' + filenameInput.value + ' \u00b7 ' + cr.message);
    } else {
      statusEl.textContent = r.message || '...';
      appendLog((r.ok ? 'OK' : 'ERR') + ' \u00b7 ' + filenameInput.value + ' \u00b7 ' + r.message);
    }
  };

  /* Boton diagnostico */
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
  btnRaw.style.background = '#4c1d95';
  btnRaw.textContent = '\ud83d\udd2c Config';
  btnRaw.onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'GET_RAW_CONFIG', payload: { ...video, tabId: _tabId, pageUrl: _pageUrl } });
    if (!r.ok) { statusEl.textContent = r.message; return; }
    const info = 'FILES: ' + r.filesKeys.join(', ') + ' | CANDIDATOS: ' + r.candidates.length + ' | ' + r.candidates.map(c => '[' + c.source + '] ' + c.quality + ' ' + (c.url||'').slice(0,50)).join(' || ');
    statusEl.textContent = info;
    appendLog('RAW \u00b7 ' + (r.videoTitle||video.vimeoId) + ' \u00b7 ' + info);
  };

  actions.append(btnDl, btnDiag, btnRaw);
  card.append(title, meta, tags, nameField, actions);
  return card;
}

function render(embeds) {
  videosEl.innerHTML = '';
  if (!embeds || !embeds.length) { statusEl.textContent = '\u26a0\ufe0f Sin embeds detectados. Recarga la pagina.'; return; }
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
  statusEl.textContent = 'Dominio guardado.';
  appendLog('CONFIG \u00b7 dominio = ' + h);
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
  if (!r || !r.ok) { statusEl.textContent = '\u274c ' + (r && r.message || 'Error al escanear.'); return; }
  _tabId   = r.tabId;
  _pageUrl = r.pageUrl;
  render(r.embeds);
}

init();
