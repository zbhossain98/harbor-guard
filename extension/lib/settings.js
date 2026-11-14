export const BOOLEAN_SETTINGS = Object.freeze([
  'enabled', 'ads', 'trackers', 'youtube', 'cosmetic',
]);

export const MAX_ALLOWLIST_SITES = 100;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  ads: true,
  trackers: true,
  youtube: true,
  cosmetic: true,
  siteAllowlist: Object.freeze([]),
});

/** Accept a hostname, never a URL, wildcard, port, or path. */
export function normalizeHostname(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase().replace(/\.$/, '');
  if (!candidate || /[\s/:\\@?#%\[\]*]/u.test(candidate)) return null;
  let hostname;
  try {
    hostname = new URL(`https://${candidate}/`).hostname;
  } catch {
    return null;
  }
  if (hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname)) return null;
  const labels = hostname.split('.');
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return null;
  }
  // URL parsers accept shorthand and alternate-base IPs. Do not silently broaden an exception.
  if (/^[0-9.]+$/.test(hostname) && hostname !== candidate) return null;
  return hostname;
}

export function isSiteAllowed(hostname, allowlist) {
  const host = normalizeHostname(hostname);
  if (!host || !Array.isArray(allowlist)) return false;
  return allowlist.some((value) => {
    const site = normalizeHostname(value);
    return site !== null && (host === site || host.endsWith(`.${site}`));
  });
}

function normalizedAllowlist(value, strict = false) {
  if (!Array.isArray(value)) {
    if (strict) throw new Error('Site exceptions must be a list of hostnames.');
    return [];
  }
  if (strict && value.length > MAX_ALLOWLIST_SITES) {
    throw new Error(`You can pause protection on up to ${MAX_ALLOWLIST_SITES} sites.`);
  }
  const sites = [];
  for (const item of value) {
    const hostname = normalizeHostname(item);
    if (hostname === null) {
      if (strict) throw new Error('A site exception contains an invalid hostname.');
      continue;
    }
    sites.push(hostname);
  }
  return [...new Set(sites)].sort().slice(0, MAX_ALLOWLIST_SITES);
}

/** Recover safely from missing or malformed persisted data. */
export function normalizeSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...Object.fromEntries(BOOLEAN_SETTINGS.map((key) => [key,
      typeof source[key] === 'boolean' ? source[key] : DEFAULT_SETTINGS[key]])),
    siteAllowlist: normalizedAllowlist(source.siteAllowlist),
  };
}

/** Validate UI updates; invalid input must not silently enable/disable protection. */
export function applySettingsPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Settings must be an object.');
  }
  const next = normalizeSettings(current);
  for (const [key, value] of Object.entries(patch)) {
    if (BOOLEAN_SETTINGS.includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
      next[key] = value;
    } else if (key === 'siteAllowlist') {
      next.siteAllowlist = normalizedAllowlist(value, true);
    } else {
      throw new Error(`Unknown setting: ${key}.`);
    }
  }
  return next;
}

export function toggleSiteSetting(current, hostname, allowed) {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error('This page does not have a supported hostname.');
  const next = normalizeSettings(current);
  const shouldAllow = typeof allowed === 'boolean' ? allowed : !isSiteAllowed(host, next.siteAllowlist);
  if (shouldAllow) {
    if (!isSiteAllowed(host, next.siteAllowlist)) next.siteAllowlist.push(host);
  } else {
    // A parent exception also pauses this host; remove it when resuming protection here.
    next.siteAllowlist = next.siteAllowlist.filter((site) => host !== site && !host.endsWith(`.${site}`));
  }
  return applySettingsPatch(current, { siteAllowlist: next.siteAllowlist });
}
