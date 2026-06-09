// popup.js
(async function () {
  'use strict';

  const body = document.getElementById('body');
  const toast = document.getElementById('toast');

  function showToast(msg, color = '#27ae60') {
    toast.textContent = msg;
    toast.style.background = color;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderEmpty(msg = 'No se detectaron videos de Vimeo.') {
    body.innerHTML = `
      <div class="state-empty">
        <div class="icon">🎬</div>
        <p>${esc(msg)}</p>
        <p class="hint">Navega a una página con un video de Vimeo,<br>espera que cargue y pulsa Reescanear.</p>
      </div>
      <div class="actions">
        <button class="btn-action" id="btn-reload">🔄 Reescanear</button>
      </div>
    `;
    document.getElementById('btn-reload')?.addEventListener('click', triggerRescan);
  }

  function renderVideos(data) {
    const { videos, title } = data;
    const mp4 = videos.filter(v => v.type === 'mp4' || (!v.type && !v.url?.includes('.m3u8')));
    const adaptive = videos.filter(v => v.type === 'hls' || v.type === 'dash');
    const all = [...mp4, ...adaptive];

    body.innerHTML = `
      ${title ? `<div class="video-title" title="${esc(title)}">🎬 ${esc(title)}</div>` : ''}
      <div class="section-title">Videos detectados (${all.length})</div>
      <div class="video-list" id="video-list"></div>
      <div class="actions">
        <button class="btn-action" id="btn-reload">🔄 Reescanear</button>
        <button class="btn-action danger" id="btn-clear">🗑 Limpiar</button>
      </div>
    `;

    const list = document.getElementById('video-list');
    all.forEach((v, i) => {
      const q = v.type === 'hls' ? 'HLS' : v.type === 'dash' ? 'DASH' : (v.height ? v.height + 'p' : (v.quality || '?'));
      const isAdaptive = v.type === 'hls' || v.type === 'dash';
      const meta = v.width && v.height ? `${v.width}×${v.height}` : (isAdaptive ? 'Streaming' : '');
      const item = document.createElement('div');
      item.className = 'video-item';
      item.innerHTML = `
        <div class="video-info">
          <span class="quality-badge ${v.type === 'hls' ? 'hls' : v.type === 'dash' ? 'dash' : ''}">${esc(q)}</span>
          ${meta ? `<span class="video-meta">${esc(meta)}</span>` : ''}
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn-download copy" data-idx="${i}" title="Copiar URL">📋</button>
          ${!isAdaptive
            ? `<a class="btn-download" href="${v.url}" download target="_blank" title="Descargar">⬇ Descargar</a>`
            : `<a class="btn-download" href="${v.url}" target="_blank" title="Abrir stream">▶ Abrir</a>`
          }
        </div>
      `;
      list.appendChild(item);
    });

    list.querySelectorAll('.copy').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(all[+btn.dataset.idx].url)
          .then(() => showToast('✅ URL copiada'))
          .catch(() => showToast('❌ Error al copiar', '#e74c3c'));
      });
    });

    document.getElementById('btn-reload')?.addEventListener('click', triggerRescan);
    document.getElementById('btn-clear')?.addEventListener('click', clearVideos);
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function triggerRescan() {
    const tab = await getActiveTab();
    if (!tab) return renderEmpty('No hay pestaña activa.');

    body.innerHTML = '<div class="state-loading"><div class="spinner"></div><span>Rescaneando...</span></div>';

    await chrome.runtime.sendMessage({ action: 'CLEAR_VIDEOS', tabId: tab.id }).catch(() => {});

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['js/inject.js']
      });
    } catch (e) {}

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => { window.__vimeoRescan?.(); }
      });
    } catch (e) {}

    await new Promise(r => setTimeout(r, 2000));
    await loadVideos(false);
  }

  async function clearVideos() {
    const tab = await getActiveTab();
    if (!tab) return;
    await chrome.runtime.sendMessage({ action: 'CLEAR_VIDEOS', tabId: tab.id }).catch(() => {});
    renderEmpty('Lista limpiada.');
  }

  async function loadVideos(autoRescan = true) {
    const tab = await getActiveTab();
    if (!tab) return renderEmpty('No hay pestaña activa.');

    try {
      const data = await chrome.runtime.sendMessage({ action: 'GET_VIDEOS', tabId: tab.id });
      if (data?.videos?.length > 0) {
        renderVideos(data);
      } else if (autoRescan) {
        await triggerRescan();
      } else {
        renderEmpty();
      }
    } catch (e) {
      renderEmpty('Error al comunicar con la extensión.');
    }
  }

  loadVideos();

})();
