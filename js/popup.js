// popup.js — sin ES modules
(function () {
  'use strict';

  var currentTab = null;

  function normalizeDomain(v) {
    return (v || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  }

  function $(s) { return document.querySelector(s); }

  function renderItem(item, allowed) {
    var el = document.createElement('section');
    el.className = 'item';
    el.innerHTML =
      '<div class="badge">Video ' + item.videoId + '</div>' +
      '<h3>' + (item.titleHint || 'Video detectado') + '</h3>' +
      '<p style="word-break:break-all;font-size:12px;color:var(--muted)">' + item.sourceUrl + '</p>' +
      '<div class="actions"><button data-action="fetch" ' + (allowed ? '' : 'disabled title="Autoriza el dominio primero"') + '>Ver descargas</button></div>' +
      '<div class="downloads"></div>';
    el.querySelector('[data-action="fetch"]').addEventListener('click', async function () {
      var box = el.querySelector('.downloads');
      box.innerHTML = '<p class="small">Consultando Vimeo&hellip;</p>';
      try {
        var res = await chrome.runtime.sendMessage({ type: 'GET_VIMEO_DOWNLOADS', videoId: item.videoId, pageUrl: item.sourceUrl });
        if (!res.ok) { box.innerHTML = '<p class="small">⚠️ ' + res.error + '</p>'; return; }
        box.innerHTML = '';
        res.files.forEach(function (file) {
          var row = document.createElement('div');
          row.className = 'row between'; row.style.marginTop = '8px';
          var label = document.createElement('span'); label.className = 'small';
          label.textContent = (file.quality || 'MP4') + (file.width ? ' · ' + file.width + 'x' + file.height : '');
          var btn = document.createElement('button');
          btn.textContent = 'Descargar';
          btn.addEventListener('click', function () {
            chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', url: file.url, filename: file.filename });
          });
          row.append(label, btn); box.appendChild(row);
        });
      } catch (e) { box.innerHTML = '<p class="small">⚠️ ' + e.message + '</p>'; }
    });
    return el;
  }

  async function injectAndScan(tabId) {
    await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, files: ['js/content.js'] });
    await new Promise(function (r) { setTimeout(r, 350); });
    return chrome.tabs.sendMessage(tabId, { type: 'SCAN_PAGE' });
  }

  async function load() {
    var statusEl = $('#status');
    statusEl.textContent = 'Leyendo…';
    $('#addDomainBtn').style.display = 'none';

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0];
    if (!currentTab || !currentTab.id) { statusEl.textContent = 'Sin pestaña activa'; return; }

    var url = currentTab.url || '';
    if (/^(chrome|edge|about|chrome-extension):/.test(url)) {
      $('#currentDomain').textContent = '-';
      statusEl.textContent = '⛔ URL no compatible';
      $('#list').innerHTML = '<div class="item"><p>Navega a una página web normal y vuelve a abrir la extensión.</p></div>';
      return;
    }

    var hostname = '';
    try { hostname = new URL(url).hostname; } catch (e) {}
    $('#currentDomain').textContent = hostname;

    var res;
    try {
      res = await chrome.tabs.sendMessage(currentTab.id, { type: 'SCAN_PAGE' });
    } catch (e1) {
      try { res = await injectAndScan(currentTab.id); }
      catch (e2) {
        statusEl.textContent = 'Error';
        $('#list').innerHTML = '<div class="item"><p>⚠️ Recarga la página (F5) y vuelve a abrir la extensión.</p></div>';
        return;
      }
    }

    if (!res.allowed) {
      statusEl.textContent = '⛔ No autorizado';
      // Mostrar botón para autorizar con un clic
      var btn = $('#addDomainBtn');
      btn.textContent = '➕ Autorizar ' + normalizeDomain(hostname);
      btn.style.display = 'block';
      btn.onclick = async function () {
        await chrome.runtime.sendMessage({ type: 'ADD_DOMAIN', domain: hostname });
        btn.style.display = 'none';
        load();
      };
    } else {
      statusEl.textContent = '✅ Autorizado';
    }

    $('#count').textContent = String(res.items.length);
    var list = $('#list');
    list.innerHTML = '';
    if (!res.items.length) {
      list.innerHTML = '<div class="item"><p>No se detectaron iframes de Vimeo en esta página.</p></div>';
      return;
    }
    res.items.forEach(function (item) { list.appendChild(renderItem(item, res.allowed)); });
  }

  document.getElementById('refreshBtn').addEventListener('click', load);
  load();
})();
