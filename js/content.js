// content.js — sin ES modules (compatible con executeScript e inyección dinámica)
(function () {
  'use strict';

  function parseVimeoId(url) {
    if (!url) return null;
    const patterns = [
      /player\.vimeo\.com\/video\/(\d+)/i,
      /vimeo\.com\/(?:video\/)?(\d+)/i
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  function normalizeDomain(value) {
    return (value || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '');
  }

  function domainMatches(hostname, allowedDomains) {
    const host = normalizeDomain(hostname);
    return (allowedDomains || []).some((entry) => {
      const d = normalizeDomain(entry);
      return d && (host === d || host.endsWith('.' + d));
    });
  }

  function addChips() {
    const iframes = [...document.querySelectorAll('iframe[src*="player.vimeo.com/video/"]')];
    for (const iframe of iframes) {
      const parent = iframe.parentElement;
      if (!parent || parent.querySelector(':scope > .vod-owner-chip')) continue;
      parent.style.position = parent.style.position || 'relative';
      const chip = document.createElement('div');
      chip.className = 'vod-owner-chip';
      chip.textContent = 'Vimeo detectado';
      chip.style.cssText = [
        'position:absolute', 'top:8px', 'right:8px', 'z-index:2147483647',
        'background:rgba(11,107,112,.92)', 'color:#fff', 'padding:6px 10px',
        'border-radius:999px', 'font:600 12px/1 system-ui,sans-serif',
        'box-shadow:0 2px 10px rgba(0,0,0,.18)', 'pointer-events:none'
      ].join(';');
      parent.appendChild(chip);
    }
  }

  async function scanPage() {
    const settings = await chrome.storage.local.get({ allowedDomains: [] });
    const allowed = domainMatches(location.hostname, settings.allowedDomains);
    const found = new Map();
    const nodes = [
      ...document.querySelectorAll('iframe[src*="player.vimeo.com/video/"]'),
      ...document.querySelectorAll('iframe[src*="vimeo.com/"]'),
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
        sourceUrl: url || ('https://player.vimeo.com/video/' + videoId),
        titleHint: node.title || node.getAttribute('aria-label') || ''
      });
    }
    addChips();
    return { allowed, hostname: location.hostname, items: [...found.values()] };
  }

  // Evitar registrar múltiples listeners si el script se inyecta más de una vez
  if (!window.__vodOwnerContentLoaded) {
    window.__vodOwnerContentLoaded = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'SCAN_PAGE') {
        scanPage().then(sendResponse);
        return true;
      }
    });
    addChips();
    new MutationObserver(addChips).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
