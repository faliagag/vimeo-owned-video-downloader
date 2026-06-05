const statusEl = document.getElementById('status');
const videosEl = document.getElementById('videos');
const hostInput = document.getElementById('allowedHost');
const hostInfo = document.getElementById('hostInfo');
const saveHostBtn = document.getElementById('saveHost');
const refreshBtn = document.getElementById('refresh');
const clearLogBtn = document.getElementById('clearLog');
const logEl = document.getElementById('log');

function normalizeHost(v) {
  return (v || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function getScan(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__scanVimeoEmbedsNow ? window.__scanVimeoEmbedsNow() : (window.__VIMEO_EMBEDS__ || [])
  });
  return result || [];
}

function badge(text) {
  const span = document.createElement('span');
  span.className = 'tag';
  span.textContent = text;
  return span;
}

async function appendLog(line) {
  const data = await chrome.storage.local.get(['activityLog']);
  const list = data.activityLog || [];
  const next = [`[${new Date().toLocaleString()}] ${line}`, ...list].slice(0, 120);
  await chrome.storage.local.set({ activityLog: next });
  renderLog(next);
}

function renderLog(list) {
  logEl.textContent = (list && list.length) ? list.join('\n') : 'Sin actividad todavía.';
}

async function loadLog() {
  const data = await chrome.storage.local.get(['activityLog']);
  renderLog(data.activityLog || []);
}

function render(videos, tab) {
  videosEl.innerHTML = '';
  if (!videos.length) {
    statusEl.textContent = 'No se detectaron embeds de Vimeo en esta página.';
    return;
  }
  statusEl.textContent = `Encontrados ${videos.length} elementos de Vimeo.`;
  videos.forEach((video, idx) => {
    const card = document.createElement('div');
    card.className = 'card';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = `${idx + 1}. ${video.titleHint || 'Embed Vimeo detectado'}${video.vimeoId ? ` · ID ${video.vimeoId}` : ''}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = video.src || tab.url || '';

    const tags = document.createElement('div');
    if (video.detectedBy) tags.appendChild(badge(`detección: ${video.detectedBy}`));
    if (video.vimeoId) tags.appendChild(badge('con ID'));
    if (video.pageUrl) tags.appendChild(badge('en página actual'));

    const nameField = document.createElement('div');
    nameField.className = 'field';
    const defaultName = (video.titleHint || `video-${video.vimeoId || idx + 1}`).replace(/"/g, '&quot;');
    nameField.innerHTML = `<label>Nombre de archivo</label><input type="text" value="${defaultName}">`;
    const filenameInput = nameField.querySelector('input');

    const qualityField = document.createElement('div');
    qualityField.className = 'field';
    qualityField.innerHTML = `<label>Calidad preferida</label><select><option value="best">La mejor disponible</option><option value="2160">2160p</option><option value="1440">1440p</option><option value="1080">1080p</option><option value="720">720p</option><option value="540">540p</option><option value="480">480p</option><option value="360">360p</option><option value="240">240p</option></select>`;
    const qualitySelect = qualityField.querySelector('select');

    const actions = document.createElement('div');
    actions.className = 'actions';

    const btn1 = document.createElement('button');
    btn1.textContent = 'Descargar';
    btn1.onclick = async () => {
      statusEl.textContent = 'Preparando descarga...';
      const payload = { ...video, pageUrl: tab.url, preferredQuality: qualitySelect.value, preferredName: filenameInput.value };
      const response = await chrome.runtime.sendMessage({ type: 'TRY_DOWNLOAD', payload });
      statusEl.textContent = response?.message || 'Proceso finalizado.';
      await appendLog(`${response?.ok ? 'OK' : 'ERROR'} · ${payload.preferredName} · ${response?.message || 'sin detalle'}`);
    };

    const btn2 = document.createElement('button');
    btn2.className = 'secondary';
    btn2.textContent = 'Diagnóstico';
    btn2.onclick = async () => {
      const response = await chrome.runtime.sendMessage({ type: 'DIAGNOSE_VIDEO', payload: { ...video, pageUrl: tab.url } });
      statusEl.textContent = response?.message || 'Diagnóstico ejecutado.';
      await appendLog(`INFO · diagnóstico ${video.vimeoId || ''} · ${response?.message || 'sin detalle'}`);
    };

    actions.append(btn1, btn2);
    card.append(title, meta, tags, nameField, qualityField, actions);
    videosEl.appendChild(card);
  });
}

async function loadHost() {
  const data = await chrome.storage.local.get(['allowedHost']);
  const allowedHost = data.allowedHost || '';
  hostInput.value = allowedHost;
  hostInfo.textContent = `Dominio permitido: ${allowedHost || 'sin configurar'}`;
}

saveHostBtn.addEventListener('click', async () => {
  const allowedHost = normalizeHost(hostInput.value);
  await chrome.storage.local.set({ allowedHost });
  hostInfo.textContent = `Dominio permitido: ${allowedHost || 'sin configurar'}`;
  statusEl.textContent = 'Dominio guardado correctamente.';
  await appendLog(`INFO · dominio permitido actualizado a ${allowedHost || 'vacío'}`);
});

refreshBtn.addEventListener('click', init);
clearLogBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ activityLog: [] });
  renderLog([]);
  statusEl.textContent = 'Registro limpiado.';
});

async function init() {
  await loadHost();
  await loadLog();
  const tab = await currentTab();
  if (!tab?.id) {
    statusEl.textContent = 'No fue posible acceder a la pestaña activa.';
    return;
  }
  const videos = await getScan(tab.id);
  render(videos, tab);
}

init();
