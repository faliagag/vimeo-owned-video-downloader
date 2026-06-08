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
    const res = await chrome.runtime.sendMessage({
      type: 'GET_VIMEO_DOWNLOADS',
      videoId: item.videoId,
      pageUrl: item.sourceUrl
    });
    if (!res.ok) { box.innerHTML = `<p class="small">${res.error}</p>`; return; }
    box.innerHTML = '';
    res.files.forEach((file) => {
      const row = document.createElement('div');
      row.className = 'row between';
      row.style.marginTop = '8px';
      const label = document.createElement('span');
      label.className = 'small';
      label.textContent = `${file.quality || 'MP4'}${file.width ? ` · ${file.width}x${file.height}` : ''}`;
      const btn = document.createElement('button');
      btn.textContent = 'Descargar';
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', url: file.url, filename: file.filename });
      });
      row.append(label, btn);
      box.appendChild(row);
    });
  });
  return el;
}

async function load() {
  $('#status').textContent = 'Leyendo pestaña&hellip;';
  const res = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE' });
  if (!res.ok) { $('#status').textContent = 'Error: ' + (res.error || ''); return; }
  $('#currentDomain').textContent = res.hostname || '-';
  $('#status').textContent = res.allowed ? '✅ Autorizado' : '⛔ No autorizado';
  $('#count').textContent = String(res.items.length);
  const list = $('#list');
  list.innerHTML = '';
  if (!res.items.length) {
    list.innerHTML = '<div class="item"><p>No se detectaron iframes o enlaces Vimeo en esta página.</p></div>';
    return;
  }
  res.items.forEach((item) => list.appendChild(renderItem(item, res.allowed)));
}

document.getElementById('refreshBtn').addEventListener('click', load);
load();
