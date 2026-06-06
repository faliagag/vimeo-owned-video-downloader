/* downloader.js v8.3
 * Recibe el buffer en CHUNKS para evitar RangeError con videos grandes.
 * Array.from() falla con Uint8Array > ~512MB en algunos motores JS.
 * Ahora el background envia el buffer en trozos de 4MB y downloader los reensambla.
 */
'use strict';

let receivedChunks = [];
let expectedChunks = 0;
let pendingMeta = null;

chrome.runtime.sendMessage({ type: 'DOWNLOADER_READY' });

chrome.runtime.onMessage.addListener(function(msg) {
  if (!msg) return;

  // Protocolo nuevo: metadata primero, luego chunks, luego TRIGGER_DOWNLOAD sin buffer
  if (msg.type === 'DOWNLOAD_META') {
    pendingMeta = { filename: msg.filename, mime: msg.mime };
    expectedChunks = msg.totalChunks;
    receivedChunks = new Array(expectedChunks);
    return;
  }

  if (msg.type === 'DOWNLOAD_CHUNK') {
    // Cada chunk es un array normal (no Uint8Array) para poder viajar por mensajeria
    receivedChunks[msg.index] = new Uint8Array(msg.data);
    return;
  }

  if (msg.type === 'DOWNLOAD_FINALIZE') {
    try {
      if (!pendingMeta) throw new Error('Sin metadata');
      // Calcular total
      let total = 0;
      for (var i = 0; i < receivedChunks.length; i++) total += receivedChunks[i].length;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (var j = 0; j < receivedChunks.length; j++) {
        merged.set(receivedChunks[j], offset);
        offset += receivedChunks[j].length;
      }
      const blob = new Blob([merged], { type: pendingMeta.mime });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = pendingMeta.filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 5000);
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_STARTED' });
    } catch(e) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: e.message });
    } finally {
      receivedChunks = [];
      pendingMeta = null;
    }
    return;
  }

  // Protocolo legado (compatibilidad): buffer completo en un mensaje
  if (msg.type === 'TRIGGER_DOWNLOAD') {
    try {
      const arr  = msg.buffer;
      const u8   = new Uint8Array(arr);
      const blob = new Blob([u8], { type: msg.mime });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = msg.filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 5000);
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_STARTED' });
    } catch(e) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: e.message });
    }
  }
});
