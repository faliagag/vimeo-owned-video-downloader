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

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['js/content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ['css/content.css']
    });
  } catch (_) {
    // La URL puede ser chrome:// u otro origen bloqueado, se ignora
  }
}

async function load() {
  const statusEl = $('#status');
  statusEl.textContent = 'Leyendo pesta\u00f1a\u2026';

  // Obtener la pestaña activa directamente en el popup
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    statusEl.textContent = 'Sin pesta\u00f1a activa';
    return;
  }

  const url = tab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('edge://')) {
    $('#currentDomain').textContent = new URL(url).hostname || url.split('/')[2] || '-';
    statusEl.textContent = '\u26d4 URL no compatible';
    $('#list').innerHTML = '<div class="item"><p>Chrome no permite que las extensiones accedan a p\u00e1ginas del sistema (<code>chrome://</code>). Navega a una p\u00e1gina web normal.</p></div>';
    return;
  }

  try {
    const hostname = new URL(url).hostname;
    $('#currentDomain').textContent = hostname;

    // Intentar escanear; si falla, inyectar primero y reintentar
    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_PAGE' });
    } catch (_) {
      // Content script no estaba activo — inyectarlo ahora
      await injectContentScript(tab.id);
      // Esperar un momento para que se inicialice
      await new Promise((r) => setTimeout(r, 300));
      try {
        res = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_PAGE' });
      } catch (e2) {
        statusEl.textContent = 'Error al inyectar script';
        $('#list').innerHTML = `<div class="item"><p>No se pudo acceder a la p\u00e1gina: ${e2.message}<br><br>Intenta <strong>recargar la p\u00e1gina</strong> y vuelve a abrir la extensi\u00f3n.</p></div>`;
        return;
      }
    }

    statusEl.textContent = res.allowed ? '\u2705 Autorizado' : '\u26d4 No autorizado';
    $('#count').textContent = String(res.items.length);
    const list = $('#list');
    list.innerHTML = '';
    if (!res.items.length) {
      list.innerHTML = '<div class="item"><p>No se detectaron iframes o enlaces Vimeo en esta p\u00e1gina.</p></div>';
      return;
    }
    res.items.forEach((item) => list.appendChild(renderItem(item, res.allowed)));
  } catch (e) {
    statusEl.textContent = 'Error';
    $('#list').innerHTML = `<div class="item"><p>${e.message}</p></div>`;
  }
}

document.getElementById('refreshBtn').addEventListener('click', load);
load();
