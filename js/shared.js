export const DEFAULTS = { allowedDomains: [] };

export function normalizeDomain(value = '') {
  return value.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

export function domainMatches(hostname, allowedDomains = []) {
  const host = normalizeDomain(hostname);
  return allowedDomains.some((entry) => {
    const d = normalizeDomain(entry);
    return d && (host === d || host.endsWith(`.${d}`));
  });
}

export async function getSettings() {
  const data = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...data };
}

export async function setSettings(settings) {
  await chrome.storage.local.set(settings);
}

export function parseVimeoId(url) {
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

export function safeFilename(name = 'video') {
  return name.replace(/[\\\/:\*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'video';
}
