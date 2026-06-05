# Vimeo Owned Video Downloader

Extensión Chrome (Manifest V3) local para detectar y descargar videos propios o autorizados embebidos desde Vimeo en tu sitio.

## Características

- Detecta iframes, links, atributos `data-*` y JSON-LD con videos de Vimeo.
- Selector de calidad (240p hasta 2160p o "la mejor disponible").
- Nombre de archivo editable antes de descargar.
- Diagnóstico por video: informa si hay archivos directos o solo streaming HLS/DASH.
- Registro local de actividad (`chrome.storage.local`).
- Restricción por dominio permitido para uso seguro.
- Sin token ni API requeridos.

## Instalación

1. Clona o descarga este repositorio.
2. Abre Chrome en `chrome://extensions/`.
3. Activa **Developer mode**.
4. Haz clic en **Load unpacked**.
5. Selecciona la carpeta del repositorio.

## Uso

1. Entra a una página de tu sitio con videos Vimeo embebidos.
2. Haz clic en el ícono de la extensión.
3. Escribe tu dominio permitido y pulsa **Guardar**.
4. Usa **Reescanear** si el contenido cargó de forma dinámica.
5. En cada video puedes editar el nombre, elegir calidad y pulsar **Descargar** o **Diagnóstico**.

## Estructura

| Archivo | Descripción |
|---|---|
| `manifest.json` | Configuración MV3 de la extensión |
| `popup.html` | Interfaz del popup |
| `popup.js` | Lógica del popup |
| `content.js` | Script de detección en páginas |
| `background.js` | Service worker: descarga y diagnóstico |
| `INSTRUCCIONES.txt` | Guía rápida de uso |

## Limitaciones

Esta herramienta funciona solo cuando Vimeo expone archivos directos (`progressive` o `download`) desde el reproductor embebido.  
Si el video entrega únicamente streaming HLS/DASH, la extensión lo informará pero no podrá convertirlo en descarga directa sin la API oficial de Vimeo.

## Uso autorizado

Diseñada exclusivamente para videos propios o con autorización expresa del titular.

---

**Versión:** 4.0.0 · Manifest V3 · Sin código remoto
