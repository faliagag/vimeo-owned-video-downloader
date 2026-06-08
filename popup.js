// popup.js — popup logic

(function () {
  'use strict';

  const contentEl = document.getElementById('content');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const toastEl = document.getElementById('toast');

  let toastTimer;

  function showToast(msg, type = '') {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'toast show ' + type;
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 2500);
  }

  function setStatus(state, text) {
    statusDot.className = 'status-dot ' + state;
    statusText.textContent = text;
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function getQualityBadgeClass(quality) {
    if (!quality) return '';
    const q = quality.toLowerCase();
    if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) return 'uhd';
    if (q.includes('1080') || q.includes('fhd')) return 'fhd';
    if (q.includes('720') || q.includes('hd')) return 'hd';
    return '';
  }

  function getQualityLabel(quality) {
    const map = { '3840x2160': '4K UHD', '2560x1440': '2K QHD', '1920x1080': '1080p FHD', '1280x720': '720p HD', '854x480': '480p', '640x360': '360p', '426x240': '240p' };
    return map[quality] || quality || 'Unknown';
  }

  function buildQualityList(files) {
    // Progressive MP4 files (direct download)
    const progressive = files.progressive || [];
    if (progressive.length === 0) return null;

    // Sort by quality descending
    const sorted = progressive.sort((a, b) => {
      const aH = parseInt((a.height || a.quality || '0'));
      const bH = parseInt((b.height || b.quality || '0'));
      return bH - aH;
    });

    return sorted;
  }

  function renderVideos(config, configUrl) {
    const title = config.video && config.video.title ? config.video.title : 'Vimeo Video';
    const files = config.request && config.request.files ? config.request.files : {};
    const qualities = buildQualityList(files);

    if (!qualities || qualities.length === 0) {
      renderEmpty('No direct download links found.', 'This video may use HLS streaming. Try the Merge option below.');
      return;
    }

    setStatus('active', 'Video detected — choose quality');

    let html = `<div class="video-title" title="${escHtml(title)}">${escHtml(title)}</div>`;
    html += '<div class="quality-list">';

    qualities.forEach(q => {
      const label = getQualityLabel(q.height ? q.width + 'x' + q.height : (q.quality || ''));
      const badgeClass = getQualityBadgeClass(q.height ? q.height + 'p' : (q.quality || ''));
      const size = q.size ? formatBytes(q.size) : '';
      const ext = 'MP4';
      const url = q.url || '';
      const filename = sanitizeFilename(title) + '_' + (q.height || q.quality || 'video') + 'p.mp4';

      html += `
        <div class="quality-item" data-url="${escHtml(url)}" data-filename="${escHtml(filename)}">
          <div class="quality-label">
            <span class="quality-badge ${badgeClass}">${escHtml(label)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            ${size ? `<span class="quality-size">${size}</span>` : ''}
            <span class="quality-ext">${ext}</span>
            <button class="download-btn" data-url="${escHtml(url)}" data-filename="${escHtml(filename)}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M12 5v14M5 12l7 7 7-7"/>
              </svg>
              Save
            </button>
          </div>
        </div>`;
    });

    html += '</div>';
    contentEl.innerHTML = html;

    // Bind download buttons
    contentEl.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const url = this.dataset.url;
        const filename = this.dataset.filename;
        if (!url) { showToast('No URL found', 'error'); return; }
        startDownload(url, filename, this);
      });
    });
  }

  function startDownload(url, filename, btn) {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="8"/></svg> ...';
    }

    chrome.runtime.sendMessage({ command: 'download', url, filename }, response => {
      if (chrome.runtime.lastError || !response) {
        showToast('Download failed', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg> Save'; }
        return;
      }
      showToast('Download started!', 'success');
      setTimeout(() => { if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg> Save'; } }, 2000);
    });
  }

  function renderEmpty(title, hint) {
    setStatus('error', 'No video found');
    contentEl.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
        <div class="empty-title">${escHtml(title)}</div>
        <div class="empty-hint">${escHtml(hint)}</div>
        <button class="refresh-btn" id="retryBtn">↺ Retry</button>
      </div>`;
    document.getElementById('retryBtn').addEventListener('click', init);
  }

  function fetchConfigFromUrl(configUrl) {
    setStatus('searching', 'Fetching video config...');
    chrome.runtime.sendMessage(
      { command: 'XMLHttpRequest', url: configUrl, method: 'GET' },
      response => {
        if (!response || response.status !== 200) {
          renderEmpty('Could not load video config.', 'Try refreshing the page and waiting for the video to start.');
          return;
        }
        try {
          const config = JSON.parse(response.responseText);
          renderVideos(config, configUrl);
        } catch (e) {
          renderEmpty('Invalid config response.', 'The video format is not supported.');
        }
      }
    );
  }

  function init() {
    setStatus('searching', 'Detecting video...');
    contentEl.innerHTML = `<div class="loading-state"><div class="spinner"></div><div style="font-size:12px;color:#555">Looking for video...</div></div>`;

    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) {
        renderEmpty('No active tab found.', '');
        return;
      }

      chrome.tabs.sendMessage(tabs[0].id, { cmd: 'getConfig' }, response => {
        if (chrome.runtime.lastError || !response) {
          renderEmpty('Could not connect to page.', 'Refresh the Vimeo page and try again.');
          return;
        }

        if (response.config) {
          // We have the full config already captured
          renderVideos(response.config, response.configUrl);
        } else if (response.configUrl) {
          // We have the URL, fetch it
          fetchConfigFromUrl(response.configUrl);
        } else {
          renderEmpty('No Vimeo video detected.', 'Open a Vimeo video page, let it start playing, then click this extension.');
        }
      });
    });
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function sanitizeFilename(name) {
    return String(name || 'video').replace(/[^a-z0-9\-_\. ]/gi, '_').replace(/\s+/g, '_').substring(0, 80);
  }

  init();
})();
