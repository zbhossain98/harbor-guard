import { connected, request, formatNumber, el } from './client.js';

const $ = (selector) => document.querySelector(selector);
let state = null;
let busy = false;
let toastTimeout;
const names = { ads: 'Ad blocking', trackers: 'Tracker blocking', youtube: 'YouTube helper', cosmetic: 'Cosmetic cleanup' };

function route() {
  const page = ['overview', 'sites', 'activity', 'setup'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('.page').forEach((node) => node.classList.toggle('hidden', node.id !== `page-${page}`));
  document.querySelectorAll('[data-page]').forEach((node) => {
    node.classList.toggle('selected', node.dataset.page === page);
    if (node.dataset.page === page) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  });
  document.title = `Harbor Guard · ${{ overview: 'Overview', sites: 'Site exceptions', activity: 'Activity', setup: 'Setup & help' }[page]}`;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => $('#toast').classList.add('hidden'), 4200);
}
function reportError(error) {
  $('#error-notice').textContent = error.message || String(error);
  $('#error-notice').classList.remove('hidden');
}
function empty(container, title, detail) {
  const node = el('div', 'empty-state');
  node.append(el('strong', '', title), el('span', '', detail));
  container.replaceChildren(node);
}
function renderSites() {
  const list = $('#sites-list');
  const sites = state?.settings.siteAllowlist ?? [];
  if (!sites.length) return empty(list, 'Room for your exceptions', connected ? 'Sites you exclude will appear here.' : 'Install the extension to manage site exceptions.');
  list.replaceChildren(...sites.map((hostname) => {
    const row = el('div', 'list-row');
    const main = el('div', 'row-main', hostname);
    main.append(el('small', '', 'Protection paused · includes subdomains'));
    const remove = el('button', 'remove-site', 'Remove');
    remove.type = 'button';
    remove.disabled = busy;
    remove.setAttribute('aria-label', `Remove exception for ${hostname}`);
    remove.addEventListener('click', () => mutate('toggleSite', { hostname, allowed: false }, 'Exception removed. Reload the site to apply.'));
    row.append(main, remove);
    return row;
  }));
}
function activityDescription(item) {
  const count = formatNumber(item.count);
  const labels = {
    cosmeticHidden: `${count} ad element${Number(item.count) === 1 ? '' : 's'} hidden`,
    youtubeSkipped: `${count} YouTube ad action${Number(item.count) === 1 ? '' : 's'}`,
    settingsChanged: 'Protection preferences updated',
    siteAllowed: 'Site exception added',
    siteProtected: 'Site exception removed',
    statsReset: 'Local activity cleared',
    installed: 'Harbor Guard is ready',
    updated: 'Harbor Guard updated'
  };
  return labels[item.kind] || 'Protection configuration updated';
}
function renderActivity() {
  const list = $('#activity-list');
  const activity = state?.activity ?? [];
  if (!activity.length) return empty(list, 'A fresh start', 'Local cleanup activity will appear as you browse.');
  list.replaceChildren(...activity.map((item) => {
    const row = el('div', 'list-row');
    const main = el('div', 'row-main', activityDescription(item));
    main.append(el('small', '', 'Saved on this device · no page URLs'));
    const date = new Date(item.at);
    const time = el('time', '', Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
    row.append(main, time);
    return row;
  }));
}
function render() {
  const enabled = Boolean(state?.settings.enabled);
  const live = connected && Boolean(state);
  const warning = state?.warning;
  $('#overall-status').classList.toggle('paused', !live || !enabled || Boolean(warning));
  $('#overall-status').replaceChildren(el('span', 'status-dot'), document.createTextNode(!live ? connected ? 'Connection unavailable' : 'Ready to install' : warning ? 'Needs attention' : enabled ? 'Protection enabled' : 'Protection paused'));
  $('#master-toggle').disabled = !live || busy;
  $('#master-toggle span').textContent = !live ? connected ? 'Reload extension' : 'Install to get protected' : enabled ? 'Pause protection' : 'Enable protection';
  $('#master-caption').textContent = !live ? connected ? 'Open your browser’s extensions page' : 'A small setup, then you’re ready.' : warning ? 'Browser rules need attention' : enabled ? 'Your browser shield is on' : 'All layers are paused';
  const rules = state?.rules;
  const activeCount = rules ? (rules.enabledRulesets.includes('ads') ? rules.adDomains : 0) + (rules.enabledRulesets.includes('trackers') ? rules.trackerDomains : 0) : null;
  $('#rule-count').textContent = live ? formatNumber(activeCount) : '—';
  $('#cleanup-count').textContent = live ? formatNumber(state.stats.cosmeticHidden) : '—';
  $('#youtube-count').textContent = live ? formatNumber(state.stats.youtubeSkipped) : '—';
  document.querySelectorAll('[data-setting]').forEach((button) => {
    const key = button.dataset.setting;
    const configured = Boolean(state?.settings[key]);
    button.setAttribute('aria-checked', String(configured));
    button.disabled = !live || busy;
    const label = $(`[data-layer-state="${key}"]`);
    label.textContent = !live ? connected ? 'Unavailable' : 'Ready to enable' : !enabled ? 'Paused globally' : configured ? 'Enabled' : 'Off';
    label.classList.toggle('inactive', !live || !enabled || !configured);
  });
  const count = state?.settings.siteAllowlist.length ?? 0;
  $('#exceptions-summary').textContent = count ? `${count} site${count === 1 ? '' : 's'} excluded` : 'No sites excluded';
  $('#add-site').disabled = !live || busy;
  $('#reset-stats').disabled = !live || busy;
  $('#site-input').disabled = !live || busy;
  if (warning) reportError(new Error(warning));
  renderSites();
  renderActivity();
}
async function mutate(type, payload, message) {
  if (busy) return;
  busy = true;
  $('#error-notice').classList.add('hidden');
  render();
  try {
    state = await request(type, payload);
    $('#error-notice').classList.add('hidden');
    if (message) toast(message);
    if (type === 'toggleSite' && payload.allowed) $('#site-input').value = '';
  } catch (error) { reportError(error); }
  finally { busy = false; render(); }
}

window.addEventListener('hashchange', route);
$('#master-toggle').addEventListener('click', () => mutate('updateSettings', { patch: { enabled: !state.settings.enabled } }, 'Protection updated. Reload open sites to apply network changes.'));
document.querySelectorAll('[data-setting]').forEach((button) => button.addEventListener('click', () => mutate('updateSettings', { patch: { [button.dataset.setting]: !state.settings[button.dataset.setting] } }, `${names[button.dataset.setting]} updated. Reload open pages if needed.`)));
$('#site-form').addEventListener('submit', (event) => {
  event.preventDefault();
  mutate('toggleSite', { hostname: $('#site-input').value.trim(), allowed: true }, 'Site exception added. Reload that site to apply.');
});
$('#reset-stats').addEventListener('click', () => mutate('resetStats', {}, 'Local activity cleared.'));
route();
try {
  const response = await fetch(new URL('../rules/source-manifest.json', import.meta.url));
  if (!response.ok) throw new Error('Filter source metadata unavailable');
  const metadata = await response.json();
  const total = formatNumber(metadata.domainCounts.ads + metadata.domainCounts.trackers);
  $('#filter-source-summary').textContent = metadata.coverageMode === 'maintained-domain-subset'
    ? `${total} domain filters from bundled EasyList/EasyPrivacy snapshots and local entries. This build supports a domain subset, with compatibility exceptions.`
    : `${total} starter domain filters. Broader upstream filter data has not been bundled in this build.`;
} catch {
  $('#filter-source-summary').textContent = 'Filter source details could not be read. Reload the extension or check rules/source-manifest.json.';
}
if (!connected) { $('#preview-notice').classList.remove('hidden'); render(); }
else {
  try { state = await request('getState'); render(); }
  catch (error) { render(); reportError(error); }
  let refreshTimer;
  chrome.storage.onChanged.addListener(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (busy) return;
      try { state = await request('getState'); render(); } catch (error) { reportError(error); }
    }, 200);
  });
}
