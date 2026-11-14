import { applySettingsPatch, isSiteAllowed, normalizeSettings, toggleSiteSetting } from './lib/settings.js';
import { applyNetworkSettings } from './lib/network.js';
import { applyYouTubeSettings } from './lib/youtube.js';
import {
  ACTIVITY_KINDS, contentSenderHostname, createActivityLimiter, EMPTY_STATS,
  isExtensionPageSender, normalizeActivity, normalizeStats, recordActivity,
} from './lib/activity.js';
import { DOMAIN_COUNTS, RULESET_COUNTS } from './rules/catalog.js';

let settings = normalizeSettings();
let stats = { ...EMPTY_STATS };
let activity = [];
let warning = null;
let initialized = false;
let queue = Promise.resolve();
const limiter = createActivityLimiter();

function serialized(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

async function updateBadge() {
  try {
    await chrome.action.setBadgeText({ text: settings.enabled ? '' : 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
  } catch {
    // Badge rendering is cosmetic and must not prevent a protection update.
  }
}

async function initialize() {
  const stored = await chrome.storage.local.get(['settings', 'stats', 'activity']);
  settings = normalizeSettings(stored.settings);
  stats = normalizeStats(stored.stats);
  activity = normalizeActivity(stored.activity);
  try {
    await applyNetworkSettings(chrome.declarativeNetRequest, settings);
    await applyYouTubeSettings(chrome.scripting, settings);
    warning = null;
  } catch (error) {
    warning = `Browser protection could not be applied: ${error.message}`;
  }
  await chrome.storage.local.set({ settings, stats, activity });
  initialized = true;
  await updateBadge();
}

async function getState() {
  let enabledRulesets = [];
  let stateWarning = warning;
  try {
    enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
  } catch (error) {
    stateWarning = `Browser rules could not be read: ${error.message}`;
  }
  return {
    settings,
    stats,
    activity,
    rules: {
      enabledRulesets,
      ads: RULESET_COUNTS.ads,
      trackers: RULESET_COUNTS.trackers,
      adDomains: DOMAIN_COUNTS.ads,
      trackerDomains: DOMAIN_COUNTS.trackers,
      allowlistedSites: settings.siteAllowlist.length,
    },
    warning: stateWarning,
  };
}

async function saveSettings(next) {
  const previous = settings;
  try {
    await applyNetworkSettings(chrome.declarativeNetRequest, next);
    await applyYouTubeSettings(chrome.scripting, next);
    await chrome.storage.local.set({ settings: next });
  } catch (error) {
    // Keep the prior configuration if a browser API/storage operation fails.
    try {
      await applyNetworkSettings(chrome.declarativeNetRequest, previous);
      await applyYouTubeSettings(chrome.scripting, previous);
    } catch (rollbackError) {
      warning = `Browser rules need attention: ${rollbackError.message}`;
    }
    throw new Error(`Protection settings could not be saved: ${error.message}`);
  }
  settings = next;
  warning = null;
  await updateBadge();
  return { ok: true, state: await getState() };
}

async function reportActivity(message, sender) {
  const hostname = contentSenderHostname(sender, chrome.runtime.id);
  if (!hostname) throw new Error('Activity must come from an extension content script.');
  if (!ACTIVITY_KINDS.includes(message.kind)) throw new Error('Unknown activity type.');
  if (!Number.isSafeInteger(message.count) || message.count < 1 || message.count > 500) {
    throw new Error('Invalid activity count.');
  }
  const isYouTube = hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  const featureEnabled = message.kind === 'youtubeSkipped'
    ? settings.youtube && isYouTube
    : settings.cosmetic || (settings.youtube && isYouTube);
  if (!settings.enabled || !featureEnabled || isSiteAllowed(hostname, settings.siteAllowlist)) {
    return { ok: true, counted: 0 };
  }
  // Limit across all frames of a tab; frame bursts cannot multiply the allowance.
  const count = limiter.take(String(sender.tab.id), message.kind, message.count);
  if (!count) return { ok: true, counted: 0 };
  const updated = recordActivity(stats, activity, message.kind, count, Date.now());
  await chrome.storage.local.set(updated);
  stats = updated.stats;
  activity = updated.activity;
  return { ok: true, counted: count };
}

async function handleMessage(message, sender) {
  if (sender?.id !== chrome.runtime.id) throw new Error('Unrecognized extension sender.');
  if (!message || typeof message !== 'object') throw new Error('Invalid message.');
  if (!initialized) await initialize();
  if (message.type === 'getSettings') return { ok: true, settings };
  if (message.type === 'reportActivity') return reportActivity(message, sender);
  // Content scripts cannot change protection or clear history through runtime messages.
  if (!isExtensionPageSender(sender, chrome.runtime.id)) throw new Error('Open the extension to change protection.');
  switch (message.type) {
    case 'getState':
      return { ok: true, state: await getState() };
    case 'updateSettings':
      return saveSettings(applySettingsPatch(settings, message.patch));
    case 'toggleSite':
      if (message.allowed !== undefined && typeof message.allowed !== 'boolean') throw new Error('allowed must be true or false.');
      return saveSettings(toggleSiteSetting(settings, message.hostname, message.allowed));
    case 'resetStats':
      await chrome.storage.local.set({ stats: { ...EMPTY_STATS }, activity: [] });
      stats = { ...EMPTY_STATS };
      activity = [];
      limiter.clear();
      return { ok: true, state: await getState() };
    default:
      throw new Error('Unknown extension action.');
  }
}

// Register listeners synchronously so Chrome can wake this service worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  serialized(() => handleMessage(message, sender))
    .then(sendResponse, (error) => sendResponse({ ok: false, error: error.message || 'The action failed.' }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void serialized(initialize).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  void serialized(initialize).catch(() => {});
});

void serialized(initialize).catch(() => {});
