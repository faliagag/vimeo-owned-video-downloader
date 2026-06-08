# Descargador Vimeo Propio — Extensión Chrome (MV3)

Extensión para detectar videos de **Vimeo embebidos** en sitios autorizados (tuyos o con permiso) y descargar el archivo MP4 progresivo cuando Vimeo lo expone.

## Estructura

```
vimeo-owned-video-downloader/
├── manifest.json
├── popup.html
├── options.html
├── _locales/
│   ├── es/messages.json
│   └── en/messages.json
├── css/
│   ├── ui.css
│   └── content.css
├── js/
│   ├── shared.js
│   ├── background.js
│   ├── content.js
│   ├── popup.js
│   └── options.js
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

## Instalación local

1. Descarga o clona este repositorio.
2. Abre Chrome y ve a `chrome://extensions`.
3. Activa el **Modo desarrollador** (esquina superior derecha).
4. Haz clic en **"Cargar descomprimida"** y selecciona la carpeta del proyecto.
5. Abre la extensión → **Opciones** y agrega tus dominios autorizados (ej. `midominio.cl`).
6. Navega a una página de tu sitio con un iframe de Vimeo → el popup detectará el video.

## Uso

- El **popup** detecta iframes y enlaces Vimeo en la pestaña activa.
- Si el dominio está autorizado en Opciones, aparece el botón **"Ver descargas"**.
- La extensión consulta `player.vimeo.com/video/{id}/config` para listar calidades MP4 progresivas disponibles.
- Se descarga el archivo usando la API `chrome.downloads`.

## Notas importantes

- **Solo funciona con videos que Vimeo expone como MP4 progresivo** (generalmente videos propios o en planes que permiten descarga).
- **Úsala exclusivamente con contenido propio o autorizado.**
- La validación por dominio es una capa de control adicional para restringir el uso.
- Versión: 2.0.0 — Arquitectura limpia MV3 con ES Modules.
