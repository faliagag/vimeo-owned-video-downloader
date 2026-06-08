// Background Service Worker
// Handles fetch requests on behalf of content scripts (avoids 403 by using page cookies)

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  const cmd = message.command;

  // Proxy a Vimeo config/player request WITH credentials (cookies)
  if (cmd === 'XMLHttpRequest') {
    const url = message.url;
    const method = message.method || 'GET';
    let retries = message.checkIsPrivate ? 1 : 4;

    const attempt = () => {
      if (retries <= 0) {
        sendResponse({ status: 500, statusText: 'Failed', responseText: 'Failed after retries' });
        return;
      }
      retries--;

      const fetchOptions = message.checkIsPrivate
        ? { method, credentials: 'omit', headers: { 'Content-Type': 'application/json' } }
        : { method, headers: { 'Content-Type': 'application/json' } };

      fetch(url, fetchOptions)
        .then(res => {
          const status = res.status;
          const statusText = res.statusText;
          return res.json().then(data => {
            if (status === 200) {
              sendResponse({ status, statusText, responseText: JSON.stringify(data) });
            } else {
              attempt();
            }
          });
        })
        .catch(() => attempt());
    };

    attempt();
    return true; // keep channel open
  }

  // Fetch with custom headers
  if (cmd === 'XMLHttpRequestHeader') {
    fetch(message.url, { method: message.method || 'GET', headers: new Headers(message.headers) })
      .then(async res => {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const data = await res.json();
          sendResponse({ data });
        } else if (message.url.includes('action=load_download_config')) {
          const text = await res.text();
          sendResponse({ data: { text }, contentType: ct });
        } else {
          sendResponse({ data: null });
        }
      })
      .catch(() => sendResponse({ data: null }));
    return true;
  }

  // Fetch Vimeo player page HTML
  if (cmd === 'player-vimeo') {
    fetch(message.url)
      .then(r => r.text())
      .then(html => sendResponse({ data: html }))
      .catch(() => sendResponse({ data: null }));
    return true;
  }

  // Trigger download via chrome.downloads API
  if (cmd === 'download') {
    chrome.downloads.download(
      { url: message.url, filename: (message.filename || 'video.mp4').trim() },
      downloadId => sendResponse({ downloadId })
    );
    return true;
  }

  // Get current tab URL
  if (cmd === 'urlFind') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      sendResponse({ url: tabs[0] ? tabs[0].url : '' });
    });
    return true;
  }

  // Open merge page
  if (message.action === 'vimeo-download-merge') {
    chrome.tabs.create({ url: chrome.runtime.getURL('merge.html') }, tab => {
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'merge-video',
          config_body: message.config_body
        });
      }, 1000);
    });
    return true;
  }
});

// Notify content scripts on tab update
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.tabs.sendMessage(tabId, { cmd: 'videoChange' }).catch(() => {});
  }
});
