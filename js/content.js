import { getSettings, domainMatches, parseVimeoId } from './shared.js';

function addChips() {
  const iframes = [...document.querySelectorAll('iframe[src*="player.vimeo.com/video/"]')];
  for (const iframe of iframes) {
    const parent = iframe.parentElement;
    if (!parent || parent.querySelector(':scope > .vod-owner-chip')) continue;
    parent.classList.add('vod-owner-wrap');
    const chip = document.createElement('div');
    chip.className = 'vod-owner-chip';
    chip.textContent = 'Vimeo detectado';
    parent.appendChild(chip);
  }
}

async function scanPage() {
  const settings = await getSettings();
  const allowed = domainMatches(location.hostname, settings.allowedDomains);
  const found = new Map();
  const nodes = [
    ...document.querySelectorAll('iframe[src*="player.vimeo.com/video/"]'),
    ...document.querySelectorAll('[data-vimeo-id]'),
    ...document.querySelectorAll('a[href*="vimeo.com/"]')
  ];
  for (const node of nodes) {
    const url = node.src || node.href || node.dataset.vimeoUrl || '';
    const dataId = node.dataset.vimeoId || '';
    const videoId = dataId || parseVimeoId(url);
    if (!videoId || found.has(videoId)) continue;
    found.set(videoId, {
      videoId,
      sourceUrl: url || `https://player.vimeo.com/video/${videoId}`,
      titleHint: node.title || node.getAttribute('aria-label') || ''
    });
  }
  addChips();
  return { allowed, hostname: location.hostname, items: [...found.values()] };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'SCAN_PAGE') {
    scanPage().then(sendResponse);
    return true;
  }
});

addChips();
new MutationObserver(addChips).observe(document.documentElement, { childList: true, subtree: true });
