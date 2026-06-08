// offscreen.js v9.9 — concatenacion binaria TS pura, sin ffmpeg/WASM
// Los segmentos HLS de Vimeo son MPEG-TS con H.264+AAC.
// Concatenar los buffers produce un archivo .ts reproducible directamente
// por VLC, mpv, y la mayoria de reproductores modernos.
// Chrome/Edge NO reproducen .ts nativamente, pero VLC si.
// Para maxima compatibilidad entregamos extension .ts con MIME video/mp2t.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'CONVERT_TS_TO_MP4') {
    handleConvert(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
});

async function handleConvert({ segments, filename }) {
  try {
    log('Recibidos ' + segments.length + ' segmentos. Concatenando...');

    // Concatenar todos los ArrayBuffer en uno solo
    const totalBytes = segments.reduce((acc, s) => acc + s.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const seg of segments) {
      merged.set(new Uint8Array(seg), offset);
      offset += seg.byteLength;
    }

    log('Total: ' + (totalBytes / 1024 / 1024).toFixed(2) + ' MB. Creando Blob...');

    // Crear Blob y URL de objeto (disponible en Offscreen Document)
    const blob = new Blob([merged], { type: 'video/mp2t' });
    const url = URL.createObjectURL(blob);

    // Nombre de archivo con extension .ts
    const tsFilename = filename.replace(/\.(mp4|mkv|webm)$/i, '') + '.ts';

    log('Iniciando descarga: ' + tsFilename);

    // Usar chrome.downloads desde el offscreen no esta disponible;
    // devolvemos la URL al background para que el SW haga la descarga.
    // PERO URL.createObjectURL es local al offscreen — no podemos pasarla.
    // Solucion: convertir a base64 data URL y descargar desde background.
    const dataUrl = await blobToDataUrl(blob);

    return { ok: true, dataUrl, filename: tsFilename, bytes: totalBytes };

  } catch (e) {
    log('ERROR: ' + e.message);
    return { ok: false, error: e.message };
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function log(msg) {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_LOG', msg }).catch(() => {});
}
