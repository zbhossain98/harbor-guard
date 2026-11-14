import { normalizeHostname } from '../lib/settings.js';

export const connected = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id && chrome.runtime?.sendMessage);
export async function request(type, payload = {}) {
  if (!connected) throw new Error('Install Harbor Guard to use protection controls.');
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || 'The extension did not respond. Reload it from your extensions page.');
  return response.state ?? response;
}
export function formatNumber(value) { return new Intl.NumberFormat().format(Number(value) || 0); }
export function siteContext(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return { hostname: '', reason: 'Browser-managed pages do not allow extension protection.' };
    const hostname = normalizeHostname(url.hostname);
    if (!hostname) return { hostname: '', reason: 'This address is not supported by site exceptions.' };
    const chromeStore = hostname === 'chromewebstore.google.com' || (hostname === 'chrome.google.com' && /^\/webstore(?:\/|$)/.test(url.pathname));
    const edgeStore = hostname === 'microsoftedge.microsoft.com' && /^\/addons(?:\/|$)/.test(url.pathname);
    if (chromeStore || edgeStore) return { hostname: '', reason: 'Extension stores do not allow page protection.' };
    return { hostname, reason: '' };
  } catch { return { hostname: '', reason: 'Open a regular website to use site controls.' }; }
}
export function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

