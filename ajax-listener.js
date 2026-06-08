// Injected into page context (MAIN world) to intercept XHR responses from Vimeo player
// This runs IN the page, not in the extension sandbox

(function () {
  'use strict';

  const vimeoReviewRegex = /vimeo\.com\/.*\/review\//;

  if (typeof XMLHttpRequest.prototype._origOpen !== 'undefined') return;

  XMLHttpRequest.prototype._origOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function () {
    this.addEventListener('load', function (e) {
      try {
        const responseText = JSON.parse(this.responseText);

        // Detect Vimeo player config response
        if (
          responseText.request &&
          responseText.request.files &&
          responseText.cdn_url &&
          responseText.cdn_url.indexOf('vimeo') !== -1
        ) {
          const params = parseUrlParams(this.responseURL);
          let isTarget = false;

          if (params.referrer) {
            isTarget = true;
          } else if (
            this.responseURL.includes('ask_ai') ||
            this.responseURL.includes('access_gates') ||
            vimeoReviewRegex.test(window.location.href)
          ) {
            isTarget = true;
          }

          if (isTarget) {
            // Store config URL in DOM element so content script can read it
            const existing = document.querySelector('.vtConfigUrl');
            if (!existing) {
              document.body.insertAdjacentHTML(
                'beforeend',
                `<span class="vtConfigUrl" url="${e.currentTarget.responseURL}" style="display:none"></span>`
              );
            } else {
              existing.setAttribute('url', e.currentTarget.responseURL);
            }

            // Also post a message for the content script to catch
            window.postMessage({ type: 'vimeoConfigUrl', url: e.currentTarget.responseURL }, '*');
          }
        }

        // Detect if this is a direct config (no referrer check needed) - standard embed
        if (
          responseText.request &&
          responseText.request.files &&
          responseText.cdn_url &&
          responseText.cdn_url.indexOf('vimeo') !== -1
        ) {
          window.postMessage({ type: 'vimeoConfigData', data: responseText, url: this.responseURL }, '*');
        }

      } catch (err) {
        // Not JSON or not a config response — ignore
      }
    });

    XMLHttpRequest.prototype._origOpen.apply(this, arguments);
  };

  // Also intercept fetch() calls for newer Vimeo player versions
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then(response => {
      const url = (args[0] instanceof Request ? args[0].url : args[0]) || '';
      if (url.includes('player.vimeo.com') && url.includes('config')) {
        response.clone().json().then(data => {
          if (data && data.request && data.request.files) {
            window.postMessage({ type: 'vimeoConfigData', data, url }, '*');
          }
        }).catch(() => {});
      }
      return response;
    });
  };

  function parseUrlParams(url) {
    const params = {};
    const qs = url.split('?')[1];
    if (qs) {
      qs.split('&').forEach(p => {
        const [k, v] = p.split('=');
        params[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
    }
    return params;
  }
})();
