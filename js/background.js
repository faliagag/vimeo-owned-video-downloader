// background.js — service worker MV3, sin import de shared.js
// (incluye las utilidades inline para no depender de ES modules en el SW)

function normalizeDomain(value) {
  return (value || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}
function domainMatches(hostname, allowedDomains) {
  var host = normalizeDomain(hostname);
  return (allowedDomains || []).some(function (entry) {
    var d = normalizeDomain(entry);
    return d && (host === d || host.endsWith('.' + d));
  });
}
function safeFilename(name) {
  return (name || 'video').replace(/[\\\/:\*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'video';
}

chrome.runtime.onInstalled.addListener(async function () {
  var data = await chrome.storage.local.get({ allowedDomains: [] });
  if (!Array.isArray(data.allowedDomains)) {
    await chrome.storage.local.set({ allowedDomains: [] });
  }
  var tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (var i = 0; i < tabs.length; i++) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabs[i].id, allFrames: true }, files: ['js/content.js'] });
    } catch (e) {}
  }
});

async function fetchVimeoConfig(videoId) {
  var urls = [
    'https://player.vimeo.com/video/' + videoId + '/config',
    'https://player.vimeo.com/video/' + videoId + '/config?autoplay=0'
  ];
  var lastError = 'No se pudo obtener config de Vimeo';
  for (var i = 0; i < urls.length; i++) {
    try {
      var r = await fetch(urls[i], { credentials: 'omit' });
      if (!r.ok) { lastError = 'HTTP ' + r.status; continue; }
      return await r.json();
    } catch (e) { lastError = e.message; }
  }
  throw new Error(lastError);
}

function extractFiles(config) {
  var title = (config && config.video && config.video.title) || 'video';
  var list = (config && config.request && config.request.files && config.request.files.progressive) || [];
  return list.filter(function (f) { return f && f.url; }).map(function (f) {
    return {
      quality: f.quality || ((f.height || '') + 'p'),
      width: f.width || null, height: f.height || null,
      url: f.url, title: title,
      filename: safeFilename(title) + ' ' + (f.quality || ((f.height || 'video') + 'p')) + '.mp4'
    };
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  (async function () {
    if (!message) return;

    if (message.type === 'ADD_DOMAIN') {
      var data = await chrome.storage.local.get({ allowedDomains: [] });
      var domains = data.allowedDomains || [];
      var nd = normalizeDomain(message.domain);
      if (nd && !domains.includes(nd)) {
        domains.push(nd);
        await chrome.storage.local.set({ allowedDomains: domains });
      }
      sendResponse({ ok: true, domains: domains });
      return;
    }

    if (message.type === 'GET_VIMEO_DOWNLOADS') {
      var settings = await chrome.storage.local.get({ allowedDomains: [] });
      var pageUrl = (sender.tab && sender.tab.url) || message.pageUrl || '';
      var hostname = '';
      try { hostname = new URL(pageUrl).hostname; } catch (e) {}
      if (!domainMatches(hostname, settings.allowedDomains)) {
        sendResponse({ ok: false, error: 'Dominio no autorizado en Opciones.' });
        return;
      }
      var config = await fetchVimeoConfig(message.videoId);
      var files = extractFiles(config);
      if (!files.length) {
        sendResponse({ ok: false, error: 'Vimeo no expone MP4 progresivos para este video.' });
        return;
      }
      sendResponse({ ok: true, title: (config.video && config.video.title) || 'video', files: files });
      return;
    }

    if (message.type === 'DOWNLOAD_FILE') {
      var dlId = await chrome.downloads.download({ url: message.url, filename: message.filename, saveAs: true });
      sendResponse({ ok: true, downloadId: dlId });
      return;
    }
  })().catch(function (e) { sendResponse({ ok: false, error: e.message || String(e) }); });
  return true;
});
