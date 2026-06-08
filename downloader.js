/* downloader.js v9.6
 * Conversor TS → MP4 usando ffmpeg.wasm (WebAssembly).
 *
 * Flujo:
 *  1. Recibe bloques Uint8Array via mensajes DOWNLOAD_CHUNK desde background.js
 *  2. En DOWNLOAD_FINALIZE ensambla todos los bloques
 *  3. Usa @ffmpeg/ffmpeg para remuxear MPEG-TS → MP4 real (-c copy, sin recodificar)
 *  4. Si ffmpeg.wasm falla o no carga → descarga los bytes como .ts.mp4 (abre en VLC)
 *
 * Mensajes entrantes: DOWNLOAD_META | DOWNLOAD_CHUNK | DOWNLOAD_FINALIZE
 * Mensajes salientes: DOWNLOAD_STARTED | DOWNLOAD_ERROR
 */

import { FFmpeg } from 'https://esm.sh/@ffmpeg/ffmpeg@0.12.10';
import { fetchFile, toBlobURL } from 'https://esm.sh/@ffmpeg/util@0.12.1';

// ── UI helpers ──────────────────────────────────────────────────────
const statusEl = document.getElementById('status');
const barWrap  = document.getElementById('bar-wrap');
const bar      = document.getElementById('bar');

function log(msg, cls) {
  statusEl.textContent += '\n' + msg;
  if (cls) statusEl.className = cls;
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

// ── Estado ────────────────────────────────────────────────────────────
let meta   = null;
const chunks = [];

// ── Listener de mensajes ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'DOWNLOAD_META') {
    meta = { filename: msg.filename || 'video-vimeo', totalChunks: msg.totalChunks };
    chunks.length = 0;
    log('Recibiendo ' + msg.totalChunks + ' bloques: "' + meta.filename + '"');
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'DOWNLOAD_CHUNK') {
    chunks[msg.index] = new Uint8Array(msg.data);
    setBar(Math.round(((msg.index + 1) / (meta?.totalChunks || 1)) * 40));
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'DOWNLOAD_FINALIZE') {
    if (!meta) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: 'Sin meta.' });
      sendResponse({ ok: false });
      return true;
    }

    // Ensamblar chunks
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
    log('Ensamblado: ' + sizeMB + ' MB. Iniciando conversión…');
    setBar(42);

    const filename = sanitize(meta.filename);

    // Lanzar conversión async
    convertToMp4(tsData, filename)
      .then(mp4data => {
        const mb = Math.round(mp4data.length / 1024 / 1024);
        log('✅ MP4 listo (' + mb + ' MB). Descargando…', 'ok');
        setBar(100);
        triggerDownload(mp4data, filename + '.mp4', 'video/mp4');
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_STARTED',
          format: 'mp4-ffmpeg',
          sizeMB: mb
        });
      })
      .catch(err => {
        log('⚠ ffmpeg.wasm falló: ' + err.message, 'err');
        log('Descargando como TS (abrir con VLC)…');
        // Fallback: descargar los bytes TS con extension .mp4
        // VLC, mpv y PotPlayer lo abren correctamente
        triggerDownload(tsData, filename + '.mp4', 'video/mp4');
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_STARTED',
          format: 'ts-fallback',
          sizeMB: sizeMB
        });
      });

    sendResponse({ ok: true });
    return true;
  }

  return true;
});

// ── Conversión con ffmpeg.wasm ───────────────────────────────────────────
async function convertToMp4(tsData, filename) {
  const ffmpeg = new FFmpeg();

  // Redirigir logs de ffmpeg al panel
  ffmpeg.on('log', ({ message }) => {
    // Solo mostrar lineas relevantes (no spam de decodificacion)
    if (/error|warning|mux|demux|Stream|Input|Output|Duration|Video|Audio/i.test(message)) {
      log(message);
    }
  });

  // Progreso de ffmpeg
  ffmpeg.on('progress', ({ progress }) => {
    setBar(42 + Math.round(progress * 55));  // 42% → 97%
  });

  log('Cargando ffmpeg.wasm…');

  // Cargar el core de ffmpeg.wasm desde CDN
  // Usamos la versión mt (multi-thread) con fallback a st (single-thread)
  let loaded = false;
  try {
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
      coreURL:   await toBlobURL(`${baseURL}/ffmpeg-core.js`,   'text/javascript'),
      wasmURL:   await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    loaded = true;
    log('ffmpeg.wasm cargado (single-thread).');
  } catch (e) {
    log('⚠ Core ESM falló: ' + e.message + '. Intentando CDN alternativo…');
  }

  if (!loaded) {
    try {
      const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`,   'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      loaded = true;
      log('ffmpeg.wasm cargado (jsDelivr).');
    } catch (e) {
      throw new Error('No se pudo cargar ffmpeg.wasm: ' + e.message);
    }
  }

  setBar(50);
  log('Escribiendo archivo de entrada (' + Math.round(tsData.length / 1024 / 1024) + ' MB)…');

  // Escribir el TS en el sistema de archivos virtual de ffmpeg
  await ffmpeg.writeFile('input.ts', tsData);

  log('Remuxeando TS → MP4 (sin recodificar)…');
  setBar(55);

  // Remux: -c copy = no recodifica, solo cambia el contenedor
  // -movflags +faststart = pone el índice al inicio (mejor para streaming)
  await ffmpeg.exec([
    '-i', 'input.ts',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y',
    'output.mp4'
  ]);

  log('Leyendo MP4 generado…');
  setBar(95);

  const mp4data = await ffmpeg.readFile('output.mp4');

  // Limpiar archivos virtuales
  try { await ffmpeg.deleteFile('input.ts');   } catch (_) {}
  try { await ffmpeg.deleteFile('output.mp4'); } catch (_) {}

  if (!mp4data || mp4data.length === 0) {
    throw new Error('ffmpeg generó un archivo vacío.');
  }

  return mp4data instanceof Uint8Array ? mp4data : new Uint8Array(mp4data);
}
