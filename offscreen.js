/* offscreen.js v9.8
 * Corre como Offscreen Document (MV3).
 * Carga ffmpeg.wasm UNA SOLA VEZ y lo reutiliza para todas las conversiones.
 *
 * Mensajes que escucha (desde background.js via chrome.runtime.sendMessage):
 *   { type: 'OFFSCREEN_CONVERT', tsData: ArrayBuffer, filename: string }
 *
 * Mensajes que emite:
 *   { type: 'OFFSCREEN_READY' }                   — wasm cargado y listo
 *   { type: 'OFFSCREEN_PROGRESS', pct, msg }       — progreso de conversion
 *   { type: 'OFFSCREEN_DONE', blobUrl, filename }  — conversion exitosa
 *   { type: 'OFFSCREEN_ERROR', error }             — fallo
 */

import { FFmpeg }    from 'https://esm.sh/@ffmpeg/ffmpeg@0.12.10';
import { toBlobURL } from 'https://esm.sh/@ffmpeg/util@0.12.1';

const ff = new FFmpeg();
let   ready = false;

// ── Progreso de ffmpeg ────────────────────────────────────────────────────────
ff.on('progress', ({ progress }) => {
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_PROGRESS',
    pct:  50 + Math.round(progress * 45),
    msg:  'Convirtiendo… ' + Math.round(progress * 100) + '%'
  }).catch(() => {});
});

ff.on('log', ({ message }) => {
  if (/error|warning|Stream|Duration|Video|Audio/i.test(message)) {
    console.log('[offscreen ffmpeg]', message);
  }
});

// ── Cargar WASM al iniciar ────────────────────────────────────────────────────
async function loadWasm() {
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
      console.log('[offscreen] ffmpeg.wasm listo desde', base);
      return true;
    } catch (e) {
      console.warn('[offscreen] CDN falló:', base, e.message);
    }
  }
  return false;
}

loadWasm().then(ok => {
  ready = ok;
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY', ok }).catch(() => {});
  console.log('[offscreen] READY emitido, ok =', ok);
});

// ── Listener de mensajes ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'OFFSCREEN_CONVERT') return true;

  (async () => {
    const { tsData, filename } = msg;

    if (!ready || !ff) {
      // Fallback: devolver los bytes tal cual para que background los descargue
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_ERROR',
        error: 'ffmpeg.wasm no disponible — descargando TS crudo.',
        fallbackData: tsData   // ArrayBuffer original
      }).catch(() => {});
      sendResponse({ ok: false });
      return;
    }

    try {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROGRESS', pct: 47, msg: 'Escribiendo input.ts…' }).catch(() => {});
      await ff.writeFile('input.ts', new Uint8Array(tsData));

      chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROGRESS', pct: 50, msg: 'Remuxeando TS→MP4…' }).catch(() => {});
      await ff.exec(['-i', 'input.ts', '-c', 'copy', '-movflags', '+faststart', '-y', 'output.mp4']);

      const raw = await ff.readFile('output.mp4');
      const mp4 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

      try { await ff.deleteFile('input.ts');   } catch (_) {}
      try { await ff.deleteFile('output.mp4'); } catch (_) {}

      if (!mp4.length) throw new Error('ffmpeg generó un archivo vacío.');

      // Crear blob URL en el contexto offscreen y pasarla al background
      const blob    = new Blob([mp4], { type: 'video/mp4' });
      const blobUrl = URL.createObjectURL(blob);
      const sizeMB  = Math.round(mp4.length / 1024 / 1024);

      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_DONE',
        blobUrl,
        filename: filename + '.mp4',
        sizeMB
      }).catch(() => {});

      sendResponse({ ok: true });

    } catch (err) {
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_ERROR',
        error: err.message,
        fallbackData: tsData
      }).catch(() => {});
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;  // mantener canal abierto
});
