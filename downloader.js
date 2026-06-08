/* downloader.js v9.0
 * Recibe chunks desde background, ensambla blob y dispara descarga.
 */
'use strict';

let meta = null;
const chunks = [];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'DOWNLOAD_META') {
    meta = { filename: msg.filename, mime: msg.mime, totalChunks: msg.totalChunks };
    chunks.length = 0;
    sendResponse({ ok: true });
  }
  else if (msg.type === 'DOWNLOAD_CHUNK') {
    chunks[msg.index] = new Uint8Array(msg.data);
    sendResponse({ ok: true });
  }
  else if (msg.type === 'DOWNLOAD_FINALIZE') {
    if (!meta) { sendResponse({ ok: false }); chrome.runtime.sendMessage({ type:'DOWNLOAD_ERROR', error:'Sin meta.' }); return; }
    try {
      let total = 0;
      for (const c of chunks) total += c.length;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }
      const blob = new Blob([merged], { type: meta.mime });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = meta.filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_STARTED' });
      sendResponse({ ok: true });
    } catch(e) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: e.message });
      sendResponse({ ok: false, error: e.message });
    }
  }
  return true;
});
