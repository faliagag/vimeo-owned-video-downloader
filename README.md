# Vimeo Owned Video Downloader v8.3

Extensión Chrome MV3 para descargar videos **propios** alojados en Vimeo e integrados como iframes en tu sitio web.

## Características

- ✅ Detecta iframes `player.vimeo.com` automáticamente
- ✅ Descarga MP4 directa cuando el player expone archivos progresivos
- ✅ Conversión HLS → `.ts` para videos con solo stream adaptativo
- ✅ Barra flotante persistente con progreso (se puede cerrar el popup)
- ✅ Sin duplicados de tarjetas ni de descargas
- ✅ Sin violaciones CSP (`unsafe-inline`) — todos los estilos en archivos externos
- ✅ Sin `RangeError` — buffer enviado en chunks de 4 MB
- ✅ Restringido al dominio que configures

## Instalación

1. Descarga o clona el repositorio
2. Abre `chrome://extensions/`
3. Activa **Modo desarrollador** (esquina superior derecha)
4. Haz clic en **Cargar sin empaquetar** y selecciona la carpeta

## Uso

1. Abre una página de tu sitio que contenga iframes de Vimeo
2. Haz clic en el ícono de la extensión
3. En **Dominio permitido**, ingresa tu dominio (ej: `www.tudominio.com`) y guarda
4. La extensión escanea automáticamente los iframes
5. Haz clic en **⬇ Descargar** en el video deseado
6. Puedes cerrar el popup — la descarga continúa

## Archivos

| Archivo | Función |
|---|---|
| `manifest.json` | Configuración MV3 |
| `background.js` | Service worker: lógica principal, HLS download |
| `popup.html/css/js` | Interfaz del popup |
| `floater.js/css` | Barra flotante en la página |
| `downloader.html/js` | Tab auxiliar para disparar Blob downloads |
| `page_scanner.js` | Detecta iframes y accede al playerConfig |
| `vimeo_interceptor.js` | Intercepta playerConfig dentro del iframe Vimeo |

## Notas

- Solo funciona con videos a los que tienes acceso como propietario o con permisos de descarga habilitados en Vimeo
- Videos con DRM no son descargables por este método
- El archivo `.ts` generado de HLS es compatible con VLC y ffmpeg
