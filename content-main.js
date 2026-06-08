// content-main.js — main content script
// Listens for messages from the injected ajax-listener.js and stores config data
// Also communicates with the popup

(function () {
  'use strict';

  let capturedConfig = null;
  let capturedConfigUrl = null;

  // Listen for messages from the MAIN world (ajax-listener.js)
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;

    if (event.data && event.data.type === 'vimeoConfigData') {
      capturedConfig = event.data.data;
      capturedConfigUrl = event.data.url;
      // Notify popup if it's open
      chrome.runtime.sendMessage({ cmd: 'configCaptured', config: capturedConfig, configUrl: capturedConfigUrl }).catch(() => {});
    }

    if (event.data && event.data.type === 'vimeoConfigUrl') {
      capturedConfigUrl = event.data.url;
    }
  });

  // Respond to popup requests
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.cmd === 'getConfig') {
      if (capturedConfig) {
        sendResponse({ config: capturedConfig, configUrl: capturedConfigUrl });
      } else {
        // Try to find config URL in DOM (injected by ajax-listener)
        const el = document.querySelector('.vtConfigUrl');
        if (el) {
          const url = el.getAttribute('url');
          sendResponse({ config: null, configUrl: url });
        } else {
          sendResponse({ config: null, configUrl: null });
        }
      }
      return true;
    }

    if (message.cmd === 'videoChange') {
      capturedConfig = null;
      capturedConfigUrl = null;
    }
  });
})();
