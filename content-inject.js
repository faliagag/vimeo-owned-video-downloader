// content-inject.js — runs at document_start, injects ajax-listener.js into the MAIN page world
// This is needed because content scripts run in an isolated world and cannot intercept page XHR

(function () {
  'use strict';

  function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('ajax-listener.js');
    script.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  injectScript();
})();
