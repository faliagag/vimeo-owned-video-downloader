import { getSettings, domainMatches, safeFilename } from './shared.js';

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  if (!Array.isArray(settings.allowedDomains)) {
    await chrome.storage.local.set({ allowedDomains: [] });
  }
});

async function fetchVimeoConfig(videoId) {
  const endpoints = [
    `https://player.vimeo.com/video/${videoId}/config`,
    `https://player.vimeo.com/video/${videoId}/config?autoplay=0&byline=0&portrait=0&title=0`
  ];
  let lastError = 'No se pudo obtener la configuración de Vimeo';
  for (const url of endpoints) {
    try {
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
      return await response.json();
    } catch (error) {
      lastError = error.message;
    }
  }
  throw new Error(lastError);
}

function extractProgressiveFiles(config) {
  const title = config?.video?.title || 'video';
  const list = config?.request?.files?.progressive || [];
  return list
    .filter((item) => item?.url)
    .map((item) => ({
      quality: item.quality || `${item.height || ''}p`,
      width: item.width || null,
      height: item.height || null,
      fps: item.fps || null,
      mime: item.mime || 'video/mp4',
      url: item.url,
      title,
      filename: `${safeFilename(title)} ${item.quality || (item.height + 'p') || 'video'}.mp4`
    }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'GET_TAB_STATE') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No hay pestaña activa');
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_PAGE' });
      sendResponse({ ok: true, tab, ...result });
      return;
    }
    if (message?.type === 'GET_VIMEO_DOWNLOADS') {
      const settings = await getSettings();
      const senderUrl = sender.tab?.url || message.pageUrl || '';
      const hostname = senderUrl ? new URL(senderUrl).hostname : '';
      if (!domainMatches(hostname, settings.allowedDomains)) {
        sendResponse({ ok: false, error: 'Dominio no autorizado en Opciones.' });
        return;
      }
      const config = await fetchVimeoConfig(message.videoId);
      const files = extractProgressiveFiles(config);
      if (!files.length) {
        sendResponse({ ok: false, error: 'Vimeo no expone archivos MP4 progresivos para este video.' });
        return;
      }
      sendResponse({ ok: true, title: config?.video?.title || 'video', files });
      return;
    }
    if (message?.type === 'DOWNLOAD_FILE') {
      const downloadId = await chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: true
      });
      sendResponse({ ok: true, downloadId });
      return;
    }
  })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
