// background.js - Service Worker
const videoStore = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? msg.tabId;

  if (msg.action === 'VIDEOS_FOUND') {
    if (!tabId) return sendResponse({ ok: false });
    if (!videoStore[tabId]) videoStore[tabId] = { videos: [], title: '', pageUrl: '' };
    const store = videoStore[tabId];
    if (msg.title) store.title = msg.title;
    if (msg.pageUrl) store.pageUrl = msg.pageUrl;

    const existingUrls = new Set(store.videos.map(v => v.url));
    (msg.videos || []).forEach(v => {
      if (v.url && !existingUrls.has(v.url)) {
        store.videos.push(v);
        existingUrls.add(v.url);
      }
    });

    const count = store.videos.length;
    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count), tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#1ab7ea', tabId }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'VIDEO_ELEMENT_FOUND') {
    if (!tabId) return sendResponse({ ok: false });
    if (!videoStore[tabId]) videoStore[tabId] = { videos: [], title: '', pageUrl: '' };
    const store = videoStore[tabId];
    const existingUrls = new Set(store.videos.map(v => v.url));
    if (msg.url && !existingUrls.has(msg.url)) {
      store.videos.push({ url: msg.url, quality: 'Detectado', type: 'mp4', height: 0 });
      chrome.action.setBadgeText({ text: String(store.videos.length), tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#1ab7ea', tabId }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'GET_VIDEOS') {
    const id = msg.tabId;
    const store = id ? (videoStore[id] || { videos: [], title: '', pageUrl: '' }) : { videos: [], title: '', pageUrl: '' };
    sendResponse(store);
    return true;
  }

  if (msg.action === 'CLEAR_VIDEOS') {
    const id = msg.tabId ?? tabId;
    if (id) {
      delete videoStore[id];
      chrome.action.setBadgeText({ text: '', tabId: id }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    delete videoStore[tabId];
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  delete videoStore[tabId];
});
