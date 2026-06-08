/* downloader.js v9.7
 * Conversor TS → MP4 usando ffmpeg.wasm (WebAssembly).
 *
 * v9.7:
 *  - Emite DOWNLOADER_READY cuando ffmpeg.wasm ya está cargado y listo,
 *    de forma que background.js no envía chunks antes de tiempo.
 *  - Carga ffmpeg.wasm tan pronto abre la tab (no espera DOWNLOAD_META).
 *  - Fallback a descarga .mp4-TS si wasm falla.
 *
 * Mensajes entrantes: DOWNLOAD_META | DOWNLOAD_CHUNK | DOWNLOAD_FINALIZE
 * Mensajes salientes: DOWNLOADER_READY | DOWNLOAD_STARTED | DOWNLOAD_ERROR
 */

import { FFmpeg }           from 'https://esm.sh/@ffmpeg/ffmpeg@0.12.10';
import { toBlobURL }        from 'https://esm.sh/@ffmpeg/util@0.12.1';

// ── UI helpers ────────────────────────────────────────────────────────────────
const statusEl = document.getElementById('status');
const barWrap  = document.getElementById('bar-wrap');
const bar      = document.getElementById('bar');

function log(msg, cls) {
  const line = document.createElement('div');
  line.textContent = msg;
  if (cls) line.className = cls;
  statusEl.appendChild(line);
  statusEl.scrollTop = statusEl.scrollHeight;
  console.log('[DL]', msg);
}
function setBar(pct) {
  barWrap.style.display = 'block';
  bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
}
function sanitize(n) {
  return (n || 'video-vimeo')
    .replace(/[\\\/:\*\?"<>|]+/g, '-')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}
function triggerDownload(data, filename, mime) {
  const blob = new Blob([data], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

// ── Estado global ─────────────────────────────────────────────────────────────
let meta     = null;
let ffmpegInstance = null;   // instancia reutilizable
const chunks = [];

// ── Cargar ffmpeg.wasm INMEDIATAMENTE (no esperar chunks) ────────────────────
log('Cargando ffmpeg.wasm…');
setBar(5);

async function loadFFmpeg() {
  const ff = new FFmpeg();
  ff.on('log', ({ message }) => {
    if (/error|warning|Stream|Duration|Video|Audio|mux|demux/i.test(message)) log(message);
  });
  ff.on('progress', ({ progress }) => setBar(50 + Math.round(progress * 45)));

  const CDNs = [
    'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm',
  ];

  for (const base of CDNs) {
    try {
      await ff.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`,   'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      log('✅ ffmpeg.wasm listo (' + base.replace('https://','').split('/')[0] + ').', 'ok');
      return ff;
    } catch(e) {
      log('⚠ CDN falló (' + base.split('/')[2] + '): ' + e.message);
    }
  }
  throw new Error('Ningún CDN respondió para ffmpeg.wasm.');
}

// Arrancar carga y notificar al background cuando esté listo
loadFFmpeg()
  .then(ff => {
    ffmpegInstance = ff;
    setBar(20);
    log('Esperando datos de video…');
    // ── Avisar al background que ya estamos listos ─────────────────────────
    chrome.runtime.sendMessage({ type: 'DOWNLOADER_READY' }).catch(() => {});
  })
  .catch(err => {
    log('❌ ' + err.message + '. Modo fallback activado.', 'err');
    ffmpegInstance = null;
    // Aun así avisar para que background no espere indefinidamente
    chrome.runtime.sendMessage({ type: 'DOWNLOADER_READY', fallback: true }).catch(() => {});
  });

// ── Listener de mensajes ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'DOWNLOAD_META') {
    meta = { filename: msg.filename || 'video-vimeo', totalChunks: msg.totalChunks };
    chunks.length = 0;
    log('Meta recibida: "' + meta.filename + '" | ' + msg.totalChunks + ' bloques.');
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'DOWNLOAD_CHUNK') {
    chunks[msg.index] = new Uint8Array(msg.data);
    const pct = Math.round(((msg.index + 1) / (meta?.totalChunks || 1)) * 25);
    setBar(20 + pct);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'DOWNLOAD_FINALIZE') {
    if (!meta) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: 'Sin meta.' });
      sendResponse({ ok: false });
      return true;
    }

    // Ensamblar
    let total = 0;
    for (const c of chunks) if (c) total += c.length;

    if (total === 0) {
      const err = 'Sin datos (0 bytes).';
      log(err, 'err');
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: err });
      sendResponse({ ok: false });
      return true;
    }

    const tsData = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { if (c) { tsData.set(c, offset); offset += c.length; } }

    const sizeMB = Math.round(total / 1024 / 1024);
    log('Datos ensamblados: ' + sizeMB + ' MB.');
    setBar(46);

    const filename = sanitize(meta.filename);

    if (ffmpegInstance) {
      runConvert(ffmpegInstance, tsData, filename, sizeMB);
    } else {
      log('⚠ ffmpeg no disponible — descargando como .mp4 (usar VLC).', 'err');
      triggerDownload(tsData, filename + '.mp4', 'video/mp4');
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_STARTED', format: 'ts-fallback', sizeMB });
    }

    sendResponse({ ok: true });
    return true;
  }

  return true;
});

// ── Conversión ───────────────────────────────────────────────────────────────
async function runConvert(ff, tsData, filename, sizeMB) {
  try {
    log('Escribiendo input.ts (' + sizeMB + ' MB)…');
    setBar(48);
    await ff.writeFile('input.ts', tsData);

    log('Remuxeando TS → MP4…');
    setBar(50);
    await ff.exec(['-i','input.ts','-c','copy','-movflags','+faststart','-y','output.mp4']);

    log('Leyendo output.mp4…');
    const mp4raw = await ff.readFile('output.mp4');
    const mp4data = mp4raw instanceof Uint8Array ? mp4raw : new Uint8Array(mp4raw);

    try { await ff.deleteFile('input.ts');   } catch(_) {}
    try { await ff.deleteFile('output.mp4'); } catch(_) {}

    if (!mp4data.length) throw new Error('ffmpeg generó un archivo vacío.');

    const mb = Math.round(mp4data.length / 1024 / 1024);
    log('✅ MP4 listo (' + mb + ' MB). Descargando…', 'ok');
    setBar(100);

    triggerDownload(mp4data, filename + '.mp4', 'video/mp4');
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_STARTED', format: 'mp4-ffmpeg', sizeMB: mb });

  } catch(err) {
    log('❌ Conversión falló: ' + err.message, 'err');
    log('Descargando TS crudo (abrir con VLC)…');
    triggerDownload(tsData, filename + '.mp4', 'video/mp4');
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_STARTED', format: 'ts-fallback', sizeMB,
      warning: err.message
    });
  }
}
