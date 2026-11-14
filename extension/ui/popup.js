import { connected, request, siteContext } from './client.js';
const $ = (selector) => document.querySelector(selector);
let state;
let hostname = '';
let unsupportedReason = 'Open a regular website to use site controls.';
let exception = '';
let busy = false;
let tabId;
async function showYouTubeStatus() {
  const status = $('#popup-youtube-status');
  if (!connected || !state || !tabId || !/(^|\.)youtube\.com$/.test(hostname)) return;
  status.classList.remove('hidden');
  if (!state.settings.enabled || !state.settings.youtube || exception) {
    status.textContent = 'YouTube protection is paused on this tab.';
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'getPageProtectionStatus' });
    const version = chrome.runtime.getManifest().version;
    if (result?.version !== version || !result?.settingsLoaded || !result?.youtubeEnabled
      || !result?.youtubeMainReady || !result?.youtubeCompatReady || !result?.youtubeRecoveryReady) {
      status.textContent = `Reload this YouTube tab to activate helper ${version}.`;
    } else if (result.youtubeRecoveryState === 'retrying') {
      status.textContent = 'Retrying YouTube playback. Your place in the video is kept.';
    } else if (result.youtubeRecoveryState === 'exhausted') {
      status.textContent = 'YouTube still blocked playback. Reload this tab or pause protection on this site.';
    } else status.textContent = `YouTube helper ${version} is active on this tab.`;
  } catch {
    status.textContent = 'Reload this YouTube tab so the updated helper can start.';
  }
}
function render() {
  const enabled = Boolean(state?.settings.enabled);
  exception = state?.settings.siteAllowlist.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`)) || '';
  $('#popup-title').textContent = !connected ? 'Ready when you are' : !state ? 'Connection unavailable' : state.warning ? 'Your shield needs attention' : enabled ? 'A little peace of mind.' : 'Your shield is paused';
  $('#popup-description').textContent = !connected ? 'Install the extension to turn on protection.' : !state ? 'Reload Harbor Guard from your extensions page.' : state.warning ? 'Browser rules could not be verified.' : enabled ? 'Your browser protection is enabled.' : 'Turn protection on when you’re ready.';
  $('#popup-master').textContent = !connected ? 'Install Harbor Guard' : !state ? 'Reload extension' : enabled ? 'Pause protection' : 'Enable protection';
  $('#popup-master').disabled = !state || busy;
  $('#current-site').textContent = hostname || 'Site controls unavailable';
  $('#popup-site-toggle').textContent = exception ? 'Remove site exception' : 'Pause on this site';
  $('#popup-site-toggle').disabled = !state || !hostname || busy;
  $('#popup-site-note').textContent = !hostname ? unsupportedReason : exception ? `Exception: ${exception} and its subdomains. Reload after changes.` : 'Reload the page after changing protection.';
  document.querySelectorAll('[data-setting]').forEach((button) => {
    button.setAttribute('aria-checked', String(Boolean(state?.settings[button.dataset.setting])));
    button.disabled = !state || busy;
  });
  if (state?.warning) showError(new Error(state.warning));
}
function showError(error) { $('#popup-error').textContent = error.message || String(error); $('#popup-error').classList.remove('hidden'); }
async function mutate(type, payload) {
  if (busy) return;
  busy = true; render(); $('#popup-error').classList.add('hidden');
  try { state = await request(type, payload); }
  catch (error) { showError(error); }
  finally { busy = false; render(); await showYouTubeStatus(); }
}
$('#popup-master').addEventListener('click', () => mutate('updateSettings', { patch: { enabled: !state.settings.enabled } }));
$('#popup-site-toggle').addEventListener('click', () => mutate('toggleSite', { hostname: exception || hostname, allowed: !exception }));
document.querySelectorAll('[data-setting]').forEach((button) => button.addEventListener('click', () => mutate('updateSettings', { patch: { [button.dataset.setting]: !state.settings[button.dataset.setting] } })));
$('#open-dashboard').addEventListener('click', () => connected ? chrome.runtime.openOptionsPage() : window.open('dashboard.html', '_blank'));
if (connected) {
  try {
    state = await request('getState');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    const context = siteContext(tab?.url);
    hostname = context.hostname;
    unsupportedReason = context.reason;
  } catch (error) { showError(error); }
}
render();
await showYouTubeStatus();
