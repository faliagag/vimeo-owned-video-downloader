/* downloader.js v7.0
 * Esta página auxiliar se abre momentáneamente en segundo plano.
 * Recibe el buffer desde el SW via chrome.runtime.sendMessage,
 * crea un Blob URL real (sin límite de 2MB) y dispara la descarga.
 */
'use strict';

chrome.runtime.sendMessage({ type: 'DOWNLOADER_READY' });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'TRIGGER_DOWNLOAD') return;
  try {
    const uint8 = new Uint8Array(msg.buffer);
    const blob = new Blob([uint8], { type: msg.mime || 'video/mp2t' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = msg.filename || 'video.ts';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      document.body.removeChild(a);
    }, 5000);
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_STARTED' });
    sendResponse({ ok: true });
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: e.message });
    sendResponse({ ok: false, error: e.message });
  }
  return true;
});
