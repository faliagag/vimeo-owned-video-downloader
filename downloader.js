/* downloader.js v9.1
 * Recibe segmentos TS desde background.js
 * Intenta reempaquetar a MP4 usando mux.js (muxjs.Transmuxer)
 * Fallback: descarga directa como .ts si mux.js falla
 */
'use strict';

let meta = null;
const chunks = [];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'DOWNLOAD_META') {
    meta = { filename: msg.filename, mime: msg.mime, totalChunks: msg.totalChunks };
    chunks.length = 0;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'DOWNLOAD_CHUNK') {
    chunks[msg.index] = new Uint8Array(msg.data);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'DOWNLOAD_FINALIZE') {
    if (!meta) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: 'Sin meta.' });
      sendResponse({ ok: false });
      return true;
    }
    // Ensamblar TS
    let total = 0;
    for (const c of chunks) if (c) total += c.length;
    const tsData = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { if (c) { tsData.set(c, offset); offset += c.length; } }

    const filename = meta.filename || 'video-vimeo';

    // Intentar remux TS->MP4 con mux.js
    tryRemuxToMp4(tsData, filename)
      .then(mp4data => {
        triggerDownload(mp4data, filename + '.mp4', 'video/mp4');
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_STARTED',
          format: 'mp4',
          sizeMB: Math.round(mp4data.length / 1024 / 1024)
        });
      })
      .catch(err => {
        console.warn('[Downloader] mux.js falló, descargando .ts:', err.message);
        // Fallback: descargar .ts
        triggerDownload(tsData, filename + '.mp4', 'video/mp4');  // muchos reproductores abren .ts con extension .mp4
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_STARTED',
          format: 'ts-as-mp4',
          sizeMB: Math.round(tsData.length / 1024 / 1024)
        });
      });

    sendResponse({ ok: true });
    return true;
  }
  return true;
});

function triggerDownload(data, filename, mime) {
  const blob = new Blob([data], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

function tryRemuxToMp4(tsData, filename) {
  return new Promise((resolve, reject) => {
    // Verificar que mux.js esté disponible
    if (typeof window.muxjs === 'undefined' || !window.muxjs?.mp4?.Transmuxer) {
      return reject(new Error('mux.js no disponible'));
    }
    try {
      const transmuxer = new window.muxjs.mp4.Transmuxer({
        keepOriginalTimestamps: true
      });
      const mp4Segments = [];

      transmuxer.on('data', segment => {
        if (segment.initSegment) mp4Segments.push(segment.initSegment);
        mp4Segments.push(segment.data);
      });

      transmuxer.on('done', () => {
        if (!mp4Segments.length) return reject(new Error('mux.js: sin segmentos de salida'));
        let totalLen = 0;
        for (const s of mp4Segments) totalLen += s.byteLength || s.length;
        const out = new Uint8Array(totalLen);
        let off = 0;
        for (const s of mp4Segments) {
          const arr = s instanceof Uint8Array ? s : new Uint8Array(s.buffer || s);
          out.set(arr, off);
          off += arr.length;
        }
        resolve(out);
      });

      transmuxer.on('error', err => {
        reject(new Error('mux.js error: ' + (err?.message || JSON.stringify(err))));
      });

      // Procesar en bloques de 1MB para no bloquear
      const BLOCK = 1024 * 1024;
      let pos = 0;
      function pushBlock() {
        if (pos >= tsData.length) {
          transmuxer.flush();
          return;
        }
        const end = Math.min(pos + BLOCK, tsData.length);
        transmuxer.push(tsData.slice(pos, end));
        pos = end;
        setTimeout(pushBlock, 0);
      }
      pushBlock();

    } catch(e) {
      reject(new Error('mux.js excepción: ' + e.message));
    }
  });
}
