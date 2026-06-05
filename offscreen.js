/* offscreen.js - Conversor HLS -> MP4 usando ffmpeg.wasm
 * Corre en un Offscreen Document (sin UI, invisible al usuario)
 */

const FFMPEG_CDN = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/umd/ffmpeg.js';
const CORE_CDN  = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js';

let ffmpegInstance = null;
let ffmpegLoading  = false;
let ffmpegReady    = false;

/* Cargar ffmpeg.wasm dinamicamente */
async function loadFfmpeg() {
  if (ffmpegReady && ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) {
    return new Promise(function(resolve) {
      var iv = setInterval(function() {
        if (ffmpegReady) { clearInterval(iv); resolve(ffmpegInstance); }
      }, 200);
    });
  }
  ffmpegLoading = true;
  sendProgress('Cargando ffmpeg.wasm...');

  return new Promise(function(resolve, reject) {
    var script = document.createElement('script');
    script.src = FFMPEG_CDN;
    script.onload = async function() {
      try {
        var { FFmpeg } = window.FFmpegWASM || {};
        if (!FFmpeg) {
          /* Intentar acceso alternativo */
          var mod = window.FFmpeg || {};
          FFmpeg = mod.FFmpeg;
        }
        if (!FFmpeg) throw new Error('FFmpeg class no encontrada en el bundle.');
        var ff = new FFmpeg();
        ff.on('log', function(e) { console.log('[ffmpeg]', e.message); });
        ff.on('progress', function(e) {
          sendProgress('Convirtiendo... ' + Math.round((e.progress || 0) * 100) + '%');
        });
        await ff.load({ coreURL: CORE_CDN });
        ffmpegInstance = ff;
        ffmpegReady    = true;
        ffmpegLoading  = false;
        sendProgress('ffmpeg listo.');
        resolve(ff);
      } catch(e) {
        ffmpegLoading = false;
        reject(e);
      }
    };
    script.onerror = function() {
      ffmpegLoading = false;
      reject(new Error('No se pudo cargar ffmpeg.wasm desde CDN.'));
    };
    document.head.appendChild(script);
  });
}

function sendProgress(text) {
  chrome.runtime.sendMessage({ type: 'CONVERT_PROGRESS', message: text }).catch(function(){});
}

/* Descargar todos los fragmentos del m3u8 y ensamblarlos */
async function fetchHlsSegments(m3u8Url, referer) {
  sendProgress('Descargando manifiesto HLS...');
  var headers = { 'Referer': referer || '' };
  var res = await fetch(m3u8Url, { headers: headers });
  if (!res.ok) throw new Error('No se pudo descargar el manifiesto: ' + res.status);
  var text = await res.text();

  /* Si es un manifiesto maestro, elegir la variante de mayor calidad */
  if (text.includes('#EXT-X-STREAM-INF')) {
    var lines = text.split('\n');
    var variants = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        var bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
        var bw = bwMatch ? parseInt(bwMatch[1]) : 0;
        var uri = lines[i + 1] && lines[i + 1].trim();
        if (uri && !uri.startsWith('#')) variants.push({ bw: bw, uri: uri });
      }
    }
    if (!variants.length) throw new Error('No se encontraron variantes en el manifiesto maestro.');
    variants.sort(function(a, b) { return b.bw - a.bw; });
    var bestUri = variants[0].uri;
    /* Resolver URL relativa */
    var variantUrl = bestUri.startsWith('http') ? bestUri : new URL(bestUri, m3u8Url).href;
    sendProgress('Variante seleccionada (' + Math.round(variants[0].bw / 1000) + ' kbps). Descargando lista...');
    res  = await fetch(variantUrl, { headers: headers });
    text = await res.text();
    m3u8Url = variantUrl;
  }

  /* Parsear segmentos */
  var segLines = text.split('\n').filter(function(l) { return l.trim() && !l.startsWith('#'); });
  if (!segLines.length) throw new Error('No se encontraron segmentos en el manifiesto.');

  sendProgress('Descargando ' + segLines.length + ' segmentos...');
  var chunks = [];
  var base = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
  for (var j = 0; j < segLines.length; j++) {
    var segUrl = segLines[j].trim().startsWith('http') ? segLines[j].trim() : base + segLines[j].trim();
    if (j % 10 === 0) sendProgress('Descargando segmento ' + (j + 1) + '/' + segLines.length + '...');
    var segRes = await fetch(segUrl, { headers: headers });
    if (!segRes.ok) throw new Error('Error descargando segmento ' + (j + 1) + ': ' + segRes.status);
    chunks.push(new Uint8Array(await segRes.arrayBuffer()));
  }

  /* Concatenar todos los chunks TS */
  var total = chunks.reduce(function(s, c) { return s + c.length; }, 0);
  var merged = new Uint8Array(total);
  var offset = 0;
  chunks.forEach(function(c) { merged.set(c, offset); offset += c.length; });
  sendProgress('Segmentos descargados (' + Math.round(total / 1024 / 1024) + ' MB). Convirtiendo a MP4...');
  return merged;
}

async function convertHlsToMp4(m3u8Url, outputName, referer) {
  var ff = await loadFfmpeg();

  var tsData = await fetchHlsSegments(m3u8Url, referer);

  /* Escribir el archivo TS concatenado en el sistema de archivos virtual de ffmpeg */
  await ff.writeFile('input.ts', tsData);

  sendProgress('Convirtiendo TS a MP4...');
  await ff.exec(['-i', 'input.ts', '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);

  var mp4Data = await ff.readFile('output.mp4');
  /* Limpiar archivos temporales */
  await ff.deleteFile('input.ts').catch(function(){});
  await ff.deleteFile('output.mp4').catch(function(){});

  sendProgress('Conversion completada. Iniciando descarga...');

  /* Crear blob y disparar descarga */
  var blob = new Blob([mp4Data.buffer], { type: 'video/mp4' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href     = url;
  a.download = (outputName || 'video') + '.mp4';
  document.body.appendChild(a);
  a.click();
  setTimeout(function() {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 5000);

  return { ok: true, size: Math.round(mp4Data.length / 1024 / 1024) };
}

/* Escuchar mensajes del background */
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg && msg.type === 'CONVERT_HLS') {
    var payload = msg.payload;
    convertHlsToMp4(payload.hlsUrl, payload.title, payload.referer)
      .then(function(r) { sendResponse({ ok: true, message: '\u2705 Conversion completada ~' + r.size + ' MB' }); })
      .catch(function(e) { sendResponse({ ok: false, message: '\u274c Error: ' + e.message }); });
    return true; /* async */
  }
});

/* Precargar ffmpeg al iniciar */
loadFfmpeg().catch(function(e) { console.warn('ffmpeg preload failed:', e.message); });
