const $ = (s) => document.querySelector(s);

function renderItem(item, allowed) {
  const el = document.createElement('section');
  el.className = 'item';
  el.innerHTML = `
    <div class="badge">Video ${item.videoId}</div>
    <h3>${item.titleHint || 'Video detectado'}</h3>
    <p>${item.sourceUrl}</p>
    <div class="actions">
      <button ${allowed ? '' : 'disabled title="Agrega este dominio en Opciones"'} data-action="fetch">Ver descargas</button>
    </div>
    <div class="downloads"></div>
  `;
  el.querySelector('[data-action="fetch"]').addEventListener('click', async () => {
    const box = el.querySelector('.downloads');
    box.innerHTML = '<p class="small">Consultando Vimeo&hellip;</p>';
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GET_VIMEO_DOWNLOADS',
        videoId: item.videoId,
        pageUrl: item.sourceUrl
      });
      if (!res.ok) { box.innerHTML = `<p class="small">⚠️ ${res.error}</p>`; return; }
      box.innerHTML = '';
      res.files.forEach((file) => {
        const row = document.createElement('div');
        row.className = 'row between';
        row.style.marginTop = '8px';
        const label = document.createElement('span');
        label.className = 'small';
        label.textContent = `${file.quality || 'MP4'}${file.width ? ` \u00b7 ${file.width}x${file.height}` : ''}`;
        const btn = document.createElement('button');
        btn.textContent = 'Descargar';
        btn.addEventListener('click', async () => {
          await chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', url: file.url, filename: file.filename });
        });
        row.append(label, btn);
        box.appendChild(row);
      });
    } catch (e) {
      box.innerHTML = `<p class="small">⚠️ ${e.message}</p>`;
    }
  });
  return el;
}

async function injectAndScan(tabId) {
  // Inyectar como script clásico (no module) para compatibilidad total
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['js/content.js']
  });
  await new Promise((r) => setTimeout(r, 300));
  return chrome.tabs.sendMessage(tabId, { type: 'SCAN_PAGE' });
}

async function load() {
  const statusEl = $('#status');
  statusEl.textContent = 'Leyendo pesta\u00f1a\u2026';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { statusEl.textContent = 'Sin pesta\u00f1a activa'; return; }

  const url = tab.url || '';
  if (/^(chrome|edge|about|chrome-extension):/.test(url)) {
    $('#currentDomain').textContent = '-';
    statusEl.textContent = '\u26d4 URL no compatible';
    $('#list').innerHTML = '<div class="item"><p>Navega a una p\u00e1gina web normal (http/https) y vuelve a abrir la extensi\u00f3n.</p></div>';
    return;
  }

  try {
    $('#currentDomain').textContent = new URL(url).hostname;
  } catch (_) {}

  let res;
  // Intento 1: el content script ya está activo
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_PAGE' });
  } catch (_) {
    // Intento 2: inyectar y reintentar
    try {
      res = await injectAndScan(tab.id);
    } catch (e2) {
      statusEl.textContent = 'Error';
      $('#list').innerHTML = `<div class="item"><p>⚠️ No se pudo acceder a la p\u00e1gina.<br><br><strong>Recarga la p\u00e1gina</strong> (F5) y vuelve a abrir la extensi\u00f3n.</p></div>`;
      return;
    }
  }

  statusEl.textContent = res.allowed ? '\u2705 Autorizado' : '\u26d4 No autorizado (agrega el dominio en Opciones)';
  $('#count').textContent = String(res.items.length);
  const list = $('#list');
  list.innerHTML = '';
  if (!res.items.length) {
    list.innerHTML = '<div class="item"><p>No se detectaron iframes de Vimeo en esta p\u00e1gina.</p></div>';
    return;
  }
  res.items.forEach((item) => list.appendChild(renderItem(item, res.allowed)));
}

document.getElementById('refreshBtn').addEventListener('click', load);
load();
