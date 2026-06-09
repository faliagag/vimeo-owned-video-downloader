// content.js - Content script (contexto aislado)
(function () {
  'use strict';

  function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('js/inject.js');
    script.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(script);
  }

  injectScript();

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg?.type) return;

    if (msg.type === 'VIMEO_VIDEOS_FOUND') {
      chrome.runtime.sendMessage({
        action: 'VIDEOS_FOUND',
        videos: msg.videos,
        title: msg.title,
        pageUrl: location.href
      }).catch(() => {});
    }
  });

  function checkVideoElements() {
    document.querySelectorAll('video').forEach(video => {
      const src = video.src || video.currentSrc;
      if (src && (src.includes('vimeocdn') || src.includes('vimeo'))) {
        chrome.runtime.sendMessage({
          action: 'VIDEO_ELEMENT_FOUND',
          url: src,
          pageUrl: location.href
        }).catch(() => {});
      }
    });
  }

  const obs = new MutationObserver(checkVideoElements);
  const start = () => {
    if (document.body) {
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
      checkVideoElements();
    }
  };
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', start)
    : start();

})();
