// shared.js — sin export/import, se expone como window.VodShared
(function () {
  'use strict';
  window.VodShared = {
    normalizeDomain: function (value) {
      return (value || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/$/, '');
    },
    domainMatches: function (hostname, allowedDomains) {
      var host = window.VodShared.normalizeDomain(hostname);
      return (allowedDomains || []).some(function (entry) {
        var d = window.VodShared.normalizeDomain(entry);
        return d && (host === d || host.endsWith('.' + d));
      });
    },
    safeFilename: function (name) {
      return (name || 'video').replace(/[\\\/:\*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'video';
    },
    parseVimeoId: function (url) {
      if (!url) return null;
      var patterns = [
        /player\.vimeo\.com\/video\/(\d+)/i,
        /vimeo\.com\/(?:video\/)?(\d+)/i
      ];
      for (var i = 0; i < patterns.length; i++) {
        var m = url.match(patterns[i]);
        if (m) return m[1];
      }
      return null;
    }
  };
})();
