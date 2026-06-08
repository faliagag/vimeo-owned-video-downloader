/* downloader.js v9.4
 *
 * Recibe bloques Uint8Array (segmentos .ts concatenados) desde background.js,
 * los ensambla y los descarga como .mp4 usando una de estas estrategias:
 *
 *  1. Blob directo con MIME video/mp4  (funciona en la mayoria de reproductores
 *     porque el contenedor sigue siendo MPEG-TS pero con extension .mp4 — sirve
 *     para reproduccion local con VLC, PotPlayer, mpv, etc.)
 *
 *  2. Si el browser soporta WebCodecs + mp4-muxer, hace un remux real TS->MP4
 *     (fMP4 fragmented). Esto es experimental y solo se activa si la API esta
 *     disponible.
 *
 * Protocolo de mensajes desde background.js:
 *   DOWNLOAD_META   { filename, totalChunks }
 *   DOWNLOAD_CHUNK  { index, data: number[] }
 *   DOWNLOAD_FINALIZE
 */
'use strict';

const log = (msg, cls) => {
  const el = document.getElementById('status');
  if (el) { el.textContent += '\n' + msg; el.className = cls || ''; }
  console.log('[DL]', msg);
};

let meta   = null;
const chunks = [];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'DOWNLOAD_META') {
    meta = { filename: msg.filename || 'video-vimeo', totalChunks: msg.totalChunks };
    chunks.length = 0;
    log('Recibiendo ' + msg.totalChunks + ' bloques para: ' + meta.filename);
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

    // Ensamblar todos los chunks en un unico Uint8Array
    let total = 0;
    for (const c of chunks) if (c) total += c.length;

    if (total === 0) {
      const err = 'Sin datos recibidos (0 bytes).';
      log(err, 'err');
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: err });
      sendResponse({ ok: false });
      return true;
    }

    const tsData = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { if (c) { tsData.set(c, offset); offset += c.length; } }

    log('Ensamblado: ' + Math.round(total / 1024 / 1024) + ' MB. Preparando descarga…');

    const filename = sanitize(meta.filename);

    // Intentar descarga — siempre como .mp4
    downloadAsMP4(tsData, filename);
    sendResponse({ ok: true });
    return true;
  }

  return true;
});

/* ------------------------------------------------------------------ */

function sanitize(n) {
  return (n || 'video-vimeo')
    .replace(/[\\/:\*\?"<>|]+/g, '-')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}

function triggerDownload(data, filename, mime) {
  const blob = new Blob([data], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

/**
 * downloadAsMP4
 *
 * Descarga el buffer como .mp4.
 * Primero intenta un remux liviano con mux.js si esta disponible en la pagina
 * (lo cargamos via script tag dinamico).
 * Si no, descarga directamente — los datos TS con extension .mp4 abren en VLC/mpv.
 */
function downloadAsMP4(tsData, filename) {
  // Cargar muxjs desde CDN e intentar remux
  loadScript('https://cdn.jsdelivr.net/npm/mux.js@6.3.0/dist/mux.js')
    .then(() => remuxWithMuxJs(tsData))
    .then(mp4data => {
      log('Remux OK (' + Math.round(mp4data.length / 1024 / 1024) + ' MB). Descargando…', 'ok');
      triggerDownload(mp4data, filename + '.mp4', 'video/mp4');
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_STARTED', format: 'mp4-remuxed', sizeMB: Math.round(mp4data.length / 1024 / 1024) });
    })
    .catch(err => {
      log('Remux no disponible (' + err.message + '). Descargando TS→.mp4…');
      // Fallback: descargar bytes TS con extension .mp4
      // VLC, mpv, PotPlayer y la mayoria de reproductores lo abren sin problema
      triggerDownload(tsData, filename + '.mp4', 'video/mp4');
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_STARTED', format: 'ts-mp4', sizeMB: Math.round(tsData.length / 1024 / 1024) });
    });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.muxjs) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

/**
 * remuxWithMuxJs
 * Usa muxjs.mp4.Transmuxer para convertir MPEG-TS a fMP4.
 * IMPORTANTE: mux.js espera segmentos .ts INDIVIDUALES en cada push(),
 * no el stream completo concatenado. Lo dividimos en bloques de 188*1000 bytes
 * (multiplo de 188, tamano del paquete TS).
 */
function remuxWithMuxJs(tsData) {
  return new Promise((resolve, reject) => {
    if (!window.muxjs?.mp4?.Transmuxer) {
      return reject(new Error('mux.js no tiene Transmuxer'));
    }

    const transmuxer = new window.muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
    const segments   = [];
    let   initSeg    = null;
    let   done       = false;

    transmuxer.on('data', seg => {
      if (seg.initSegment && seg.initSegment.byteLength > 0) {
        initSeg = seg.initSegment;
      }
      if (seg.data && seg.data.byteLength > 0) {
        segments.push(seg.data);
      }
    });

    transmuxer.on('done', () => {
      if (done) return;
      done = true;
      if (!segments.length) {
        return reject(new Error('mux.js: sin segmentos de salida'));
      }
      const parts = [];
      if (initSeg) parts.push(initSeg);
      parts.push(...segments);

      let totalLen = 0;
      for (const p of parts) totalLen += p.byteLength || p.length;
      const out = new Uint8Array(totalLen);
      let off = 0;
      for (const p of parts) {
        const arr = p instanceof Uint8Array ? p : new Uint8Array(p.buffer || p);
        out.set(arr, off);
        off += arr.length;
      }
      resolve(out);
    });

    transmuxer.on('error', err => {
      if (!done) { done = true; reject(new Error('mux.js: ' + (err?.message || JSON.stringify(err)))); }
    });

    // Dividir en paquetes TS de 188 bytes, agrupar de a 500 paquetes
    const PKT  = 188;
    const NPKT = 500;
    const BLOCK = PKT * NPKT; // 94 000 bytes por push

    let pos = 0;
    function pushNext() {
      if (pos >= tsData.length) {
        transmuxer.flush();
        return;
      }
      // Alinear al limite de 188 bytes
      let end = Math.min(pos + BLOCK, tsData.length);
      // Asegurarse de que el bloque sea multiplo de 188
      const rem = (end - pos) % PKT;
      if (rem !== 0 && end < tsData.length) end -= rem;

      transmuxer.push(tsData.slice(pos, end));
      pos = end;
      setTimeout(pushNext, 0);
    }
    pushNext();
  });
}
