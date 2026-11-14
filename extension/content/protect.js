/* Local, best-effort page cleanup. This script never reads page text or sends URLs. */
(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    ads: true,
    trackers: true,
    youtube: true,
    cosmetic: true,
    siteAllowlist: [],
  });
  const COSMETIC_SELECTORS = [
    "ins.adsbygoogle",
    '[id^="div-gpt-ad-"]',
    'iframe[id^="google_ads_iframe_"]',
    '[data-ad-client^="ca-pub-"][data-ad-slot]',
  ].join(",");
  const YOUTUBE_SELECTORS = [
    "ytd-ad-slot-renderer",
    "ytd-display-ad-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-video-renderer",
    "ytd-companion-slot-renderer",
  ].join(",");
  const SKIP_SELECTORS = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
  ].join(",");
  const AD_INDICATOR_SELECTORS = [
    ".ytp-ad-text",
    ".ytp-ad-duration-remaining",
    ".ytp-ad-preview-container",
    ".ytp-ad-skip-button-container",
    ".ytp-ad-skip-button-slot",
    ".ytp-ad-player-overlay",
    ".ytp-ad-simple-ad-badge",
    SKIP_SELECTORS,
  ].join(",");
  const AD_UI_SELECTORS = `${AD_INDICATOR_SELECTORS},.ytp-ad-overlay-container,.ytp-ad-overlay-slot,.ytp-ad-overlay-close-button`;

  function normalizeHostname(value) {
    if (typeof value !== "string") return "";
    return value.trim().toLowerCase().replace(/\.$/, "");
  }

  function isSiteAllowed(hostname, entries) {
    const host = normalizeHostname(hostname);
    if (!host || !Array.isArray(entries)) return false;
    return entries.some((entry) => {
      const site = normalizeHostname(entry);
      return site && (host === site || host.endsWith(`.${site}`));
    });
  }

  function isYouTubeHost(hostname) {
    const host = normalizeHostname(hostname);
    return host === "youtube.com" || host.endsWith(".youtube.com");
  }

  function resolveFeatures(settings, hostname) {
    const source = settings && typeof settings === "object" ? settings : {};
    const flag = (key) => typeof source[key] === "boolean" ? source[key] : DEFAULT_SETTINGS[key];
    const enabled = flag("enabled") && !isSiteAllowed(hostname, source.siteAllowlist);
    return {
      cosmetic: enabled && flag("cosmetic"),
      youtube: enabled && flag("youtube") && isYouTubeHost(hostname),
    };
  }

  function isExplicitAdState(className) {
    return typeof className === "string" && /(?:^|\s)ad-(?:showing|interrupting)(?:\s|$)/.test(className);
  }

  function getAdSeekTarget({ adShowing, hasAdIndicator, duration, currentTime, readyState, paused, seeking }) {
    // Short, finite ad media only. Live video, loading media, paused media and
    // unmarked normal playback must never be changed by this helper.
    if (!adShowing || !hasAdIndicator || paused !== false || seeking !== false) return null;
    if (!Number.isInteger(readyState) || readyState < 2 || readyState > 4) return null;
    if (!Number.isFinite(duration) || duration <= 0.5 || duration > 600) return null;
    if (!Number.isFinite(currentTime) || currentTime < 0 || currentTime >= duration - 0.25) return null;
    return duration;
  }

  // Pure guards are also exercised by the dependency-free Node test suite.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { isSiteAllowed, isYouTubeHost, resolveFeatures, isExplicitAdState, getAdSeekTarget };
  }
  if (typeof document === "undefined" || typeof chrome === "undefined" || !chrome.storage?.local) return;

  const MARKER = "data-pcguard-hidden";
  const markerValue = /^[a-z]{32}$/.test(chrome.runtime?.id ?? "") ? chrome.runtime.id : "local";
  const SCAN_DELAY_MS = 200;
  const REPORT_DELAY_MS = 10000;
  const AD_WATCH_INTERVAL_MS = 400;
  const AD_WATCH_MAX_MS = 120000;
  const AD_MEDIA_SETTLE_MS = 350;
  const AD_ACTION_RETRY_MS = 1500;
  const MAX_AD_SEGMENTS = 16;
  const MAX_SEEK_ATTEMPTS = 2;
  const MAX_SKIP_ATTEMPTS = 4;
  const MAX_QUEUED_ROOTS = 64;
  const MAX_HIDDEN_ELEMENTS = 2500;
  const hiddenElements = new Map();
  const queuedRoots = new Set();
  const activity = { cosmeticHidden: 0, youtubeSkipped: 0 };
  let settings = DEFAULT_SETTINGS;
  let settingsLoaded = false;
  let youtubeMainReady = false;
  let youtubeCompatReady = false;
  let youtubeRecoveryReady = false;
  let youtubeRecoveryState = 'idle';
  let settingsRevision = 0;
  let features = { cosmetic: false, youtube: false };
  let scanTimer = null;
  let reportTimer = null;
  let adWatchTimer = null;
  let style = null;
  let player = null;
  let watchedVideo = null;
  let adSession = null;
  let mediaGeneration = 0;
  let lastNormalMedia = null;
  let navigationHref = location.href;
  let observersActive = false;
  let waitingForRoot = false;
  let dismissedOverlays = new WeakSet();

  function recordActivity(kind) {
    const limit = kind === "youtubeSkipped" ? 20 : 500;
    activity[kind] = Math.min(limit, activity[kind] + 1);
    if (reportTimer !== null) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      for (const [name, count] of Object.entries(activity)) {
        activity[name] = 0;
        if (!count) continue;
        try {
          const pending = chrome.runtime.sendMessage({ type: "reportActivity", kind: name, count });
          if (pending?.catch) pending.catch(() => {});
        } catch {
          // A tab can outlive an extension reload. Reporting must never break it.
        }
      }
    }, REPORT_DELAY_MS);
  }

  function visible(element) {
    try {
      if (!element?.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
      if (element.checkVisibility && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const computed = getComputedStyle(element);
      return computed.display !== "none" && computed.visibility !== "hidden" && computed.visibility !== "collapse" && computed.opacity !== "0";
    } catch {
      return false;
    }
  }

  function ensureStyle() {
    if (style?.isConnected) return;
    style = document.createElement("style");
    style.setAttribute("data-pcguard-style", markerValue);
    style.textContent = `[${MARKER}="${markerValue}"] { display: none !important; }`;
    (document.head || document.documentElement).append(style);
  }

  function hideElement(element, feature) {
    if (!element.isConnected || hiddenElements.has(element) || hiddenElements.size >= MAX_HIDDEN_ELEMENTS) return;
    const wasVisible = visible(element);
    element.setAttribute(MARKER, markerValue);
    hiddenElements.set(element, feature);
    if (wasVisible) recordActivity("cosmeticHidden");
  }

  function restoreElement(element) {
    if (element.getAttribute(MARKER) === markerValue) element.removeAttribute(MARKER);
    hiddenElements.delete(element);
  }

  function scanRoot(root) {
    if (!root?.isConnected || !root.querySelectorAll) return;
    const groups = [];
    if (features.cosmetic) groups.push([COSMETIC_SELECTORS, "cosmetic"]);
    if (features.youtube) groups.push([YOUTUBE_SELECTORS, "youtube"]);
    for (const [selector, feature] of groups) {
      if (root.matches?.(selector)) hideElement(root, feature);
      for (const element of root.querySelectorAll(selector)) {
        hideElement(element, feature);
        if (hiddenElements.size >= MAX_HIDDEN_ELEMENTS) break;
      }
    }
  }

  function queueRoot(root) {
    if (root?.nodeType !== 1 || queuedRoots.has(document.documentElement)) return;
    if (root === document.documentElement) queuedRoots.clear();
    if (queuedRoots.size < MAX_QUEUED_ROOTS) queuedRoots.add(root);
  }

  function scheduleScan() {
    if (scanTimer !== null || (!features.cosmetic && !features.youtube)) return;
    scanTimer = setTimeout(flushScan, SCAN_DELAY_MS);
  }

  function flushScan() {
    scanTimer = null;
    if (!features.cosmetic && !features.youtube) return;
    for (const element of hiddenElements.keys()) {
      if (!element.isConnected) hiddenElements.delete(element);
    }
    ensureStyle();
    const started = performance.now();
    let processed = 0;
    for (const root of queuedRoots) {
      queuedRoots.delete(root);
      scanRoot(root);
      processed += 1;
      if (processed >= 16 || performance.now() - started > 8) break;
    }
    if (features.youtube) inspectYouTubePlayer();
    if (queuedRoots.size) scheduleScan();
  }

  const pageObserver = new MutationObserver((records) => {
    let relevant = false;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || node === style) continue;
        queueRoot(node);
        relevant = true;
      }
      if (record.removedNodes.length && features.youtube) relevant = true;
    }
    if (relevant) scheduleScan();
  });
  const rootReadyObserver = new MutationObserver(() => {
    if (!document.documentElement) return;
    rootReadyObserver.disconnect();
    waitingForRoot = false;
    // Storage can change while the parser creates the document. Re-read the
    // latest in-memory settings instead of capturing startup defaults.
    applySettings(settings);
  });
  const playerObserver = new MutationObserver((records) => {
    if (!features.youtube || !player) return;
    // Normal playback updates progress-bar styles frequently. Only ad state,
    // ad controls and media changes need a scan; never poll ordinary playback.
    const relevant = isExplicitAdState(player.className) || records.some((record) => {
      if (record.target === player && record.attributeName === "class") return true;
      if (record.target === watchedVideo && record.attributeName === "src") return true;
      const element = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
      return Boolean(element?.closest?.(AD_UI_SELECTORS));
    });
    if (relevant) scheduleScan();
  });

  function onMediaEvent(event) {
    if (["loadstart", "emptied", "loadedmetadata"].includes(event.type)) mediaGeneration += 1;
    if (event.type === "ended" && adSession?.segment.video === watchedVideo) adSession.segment.ended = true;
    scheduleScan();
  }

  function watchVideo(video) {
    if (watchedVideo === video) return;
    for (const name of ["loadstart", "emptied", "loadedmetadata", "durationchange", "playing", "ended"]) {
      watchedVideo?.removeEventListener(name, onMediaEvent);
      video?.addEventListener(name, onMediaEvent);
    }
    watchedVideo = video;
    mediaGeneration += 1;
  }

  function stopAdWatch() {
    if (adWatchTimer !== null) clearTimeout(adWatchTimer);
    adWatchTimer = null;
  }

  function scheduleAdWatch() {
    if (adWatchTimer !== null || !features.youtube || !player?.isConnected || !adSession) return;
    if (!isExplicitAdState(player.className) || adSession.exhausted || performance.now() - adSession.startedAt >= AD_WATCH_MAX_MS) return;
    adWatchTimer = setTimeout(() => {
      adWatchTimer = null;
      if (features.youtube) inspectYouTubePlayer();
    }, AD_WATCH_INTERVAL_MS);
  }

  function detachPlayer() {
    playerObserver.disconnect();
    watchVideo(null);
    player = null;
    adSession = null;
    lastNormalMedia = null;
    stopAdWatch();
    dismissedOverlays = new WeakSet();
  }

  function attachPlayer(nextPlayer) {
    if (player === nextPlayer) return;
    detachPlayer();
    player = nextPlayer;
    if (player) {
      playerObserver.observe(player, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
        attributeFilter: ["class", "disabled", "aria-disabled", "hidden", "aria-hidden", "style", "src"],
      });
    }
  }

  function enabledButton(button) {
    return visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true";
  }

  function mediaSnapshot(video) {
    return {
      video,
      source: video ? `${video.currentSrc || ""}\n${video.getAttribute("src") || ""}` : "",
      duration: video?.duration,
      generation: mediaGeneration,
    };
  }

  function mediaChanged(previous, current) {
    if (!previous) return true;
    if (previous.video !== current.video || previous.source !== current.source || previous.generation !== current.generation) return true;
    const before = previous.duration;
    const after = current.duration;
    if (Number.isFinite(before) && Number.isFinite(after)) return Math.abs(before - after) > 0.5;
    return !Object.is(before, after);
  }

  function newAdSegment(snapshot) {
    return {
      ...snapshot,
      startedAt: performance.now(),
      actedAt: null,
      reported: false,
      ended: false,
      seekAttempts: 0,
      lastSeekAt: -Infinity,
      skipAttempts: 0,
      clickedButtons: new WeakMap(),
    };
  }

  function confirmAdTransition(segment) {
    // A successful transition is evidence for the counter; an attempted click
    // or a rejected seek by itself is not. Count each media segment at most once.
    if (segment && !segment.reported && segment.actedAt !== null && performance.now() - segment.actedAt < 10000) {
      segment.reported = true;
      recordActivity("youtubeSkipped");
    }
  }

  function actOnAd(snapshot) {
    const segment = adSession.segment;
    const now = performance.now();
    if (adSession.exhausted) return;
    for (const button of player.querySelectorAll(SKIP_SELECTORS)) {
      if (segment.skipAttempts >= MAX_SKIP_ATTEMPTS) break;
      if (!enabledButton(button)) continue;
      const previous = segment.clickedButtons.get(button);
      if (previous && (previous.count >= 2 || now - previous.at < AD_ACTION_RETRY_MS)) continue;
      if (!isExplicitAdState(player.className)) return;
      segment.clickedButtons.set(button, { count: (previous?.count || 0) + 1, at: now });
      segment.skipAttempts += 1;
      try {
        button.click();
        segment.actedAt = now;
        // Clicking can synchronously replace the media or end the ad. Re-read
        // it on the next observation, never seek a stale video after a click.
        return;
      } catch {
        // A removed or unusable control must not prevent other native controls.
      }
    }

    const video = snapshot.video;
    if (!video?.isConnected || segment.seekAttempts >= MAX_SEEK_ATTEMPTS) return;
    if (now - segment.startedAt < AD_MEDIA_SETTLE_MS || now - segment.lastSeekAt < AD_ACTION_RETRY_MS) return;
    // During a mid-roll transition YouTube can mark the player as an ad before
    // replacing the main video's metadata. Wait for actual new media evidence.
    if (lastNormalMedia && !mediaChanged(lastNormalMedia, snapshot)) return;
    const target = getAdSeekTarget({
      adShowing: isExplicitAdState(player.className),
      hasAdIndicator: [...player.querySelectorAll(AD_INDICATOR_SELECTORS)].some(visible),
      duration: video.duration,
      currentTime: video.currentTime,
      readyState: video.readyState,
      paused: video.paused,
      seeking: video.seeking,
    });
    if (target === null) return;
    segment.seekAttempts += 1;
    segment.lastSeekAt = now;
    try {
      // Deliberately leave volume, mute, playback rate and playback state alone.
      video.currentTime = target;
      segment.actedAt = now;
    } catch {
      // Retry at most once after settling; native skip controls remain available.
    }
  }

  function dismissPlayerOverlays() {
    // Banner dismissal is restricted to native ad-overlay controls inside the
    // known player. No text matching, arbitrary button clicks or wall removal.
    for (const button of player.querySelectorAll(".ytp-ad-overlay-close-button")) {
      if (!button.closest(".ytp-ad-overlay-container, .ytp-ad-overlay-slot")) continue;
      if (enabledButton(button) && !dismissedOverlays.has(button)) {
        dismissedOverlays.add(button);
        try { button.click(); } catch { /* The overlay may have been removed. */ }
      }
    }
  }

  function inspectYouTubePlayer() {
    if (!features.youtube) return;
    try {
      attachPlayer(document.querySelector("#movie_player.html5-video-player, #movie_player"));
      if (!player) return;
      const video = player.querySelector("video.html5-main-video, video");
      watchVideo(video);
      const snapshot = mediaSnapshot(video);
      if (!isExplicitAdState(player.className)) {
        confirmAdTransition(adSession?.segment);
        adSession = null;
        lastNormalMedia = snapshot;
        stopAdWatch();
      } else {
        if (!adSession) {
          adSession = { startedAt: performance.now(), changes: 0, exhausted: false, segment: newAdSegment(snapshot) };
        } else {
          const segment = adSession.segment;
          const restartedAfterEnd = segment.ended && video?.ended === false && Number.isFinite(video.currentTime) && video.currentTime < video.duration - 0.25;
          if (mediaChanged(segment, snapshot) || restartedAfterEnd) {
            confirmAdTransition(segment);
            adSession.changes += 1;
            adSession.exhausted = adSession.changes >= MAX_AD_SEGMENTS;
            adSession.segment = newAdSegment(snapshot);
          }
        }
        actOnAd(snapshot);
      }
      dismissPlayerOverlays();
    } catch {
      // Player replacement can invalidate a DOM action between observations.
      // The ad-only watcher can recover, within its fixed time/action limits.
    } finally {
      scheduleAdWatch();
    }
  }

  function applySettings(nextSettings) {
    settings = nextSettings && typeof nextSettings === "object" ? nextSettings : DEFAULT_SETTINGS;
    features = resolveFeatures(settings, location.hostname);
    emitYouTubeConfig();
    for (const [element, feature] of hiddenElements) {
      if (!features[feature]) restoreElement(element);
    }
    if (!features.youtube) detachPlayer();
    if (!features.cosmetic && !features.youtube) {
      pageObserver.disconnect();
      rootReadyObserver.disconnect();
      waitingForRoot = false;
      observersActive = false;
      if (scanTimer !== null) clearTimeout(scanTimer);
      scanTimer = null;
      queuedRoots.clear();
      style?.remove();
      style = null;
      return;
    }
    if (!document.documentElement) {
      if (!waitingForRoot) {
        rootReadyObserver.observe(document, { childList: true });
        waitingForRoot = true;
      }
      return;
    }
    rootReadyObserver.disconnect();
    waitingForRoot = false;
    if (!observersActive) {
      pageObserver.observe(document.documentElement, { childList: true, subtree: true });
      observersActive = true;
    }
    queueRoot(document.documentElement);
    scheduleScan();
  }

  function emitYouTubeConfig() {
    if (!settingsLoaded || !isYouTubeHost(location.hostname)) return;
    // This one-way signal contains only a local enable flag. Page events never
    // read/write extension storage or forward anything to the background worker.
    document.dispatchEvent(new CustomEvent("harbor-guard:youtube-config", { detail: { enabled: features.youtube } }));
  }

  document.addEventListener("harbor-guard:youtube-ready", () => {
    youtubeMainReady = true;
    emitYouTubeConfig();
  });
  document.addEventListener('harbor-guard:youtube-compat-ready', (event) => {
    youtubeCompatReady = event.detail?.installed === true;
  });
  document.addEventListener('harbor-guard:youtube-recovery-ready', (event) => {
    youtubeRecoveryReady = event.detail?.installed === true;
    if (['idle', 'retrying', 'exhausted'].includes(event.detail?.phase)) youtubeRecoveryState = event.detail.phase;
  });
  chrome.runtime.onMessage?.addListener((message, sender, reply) => {
    if (message?.type !== 'getPageProtectionStatus' || sender.id !== chrome.runtime.id
      || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    if (isYouTubeHost(location.hostname)) {
      document.dispatchEvent(new CustomEvent('harbor-guard:youtube-status-request'));
    }
    reply({ version: '0.3.3', settingsLoaded, youtubeEnabled: features.youtube, youtubeMainReady, youtubeCompatReady, youtubeRecoveryReady, youtubeRecoveryState });
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.settings) {
      settingsRevision += 1;
      settingsLoaded = true;
      applySettings(changes.settings.newValue);
    }
  });
  function onNavigation() {
    // YouTube can emit data updates for the current page. Only a real route
    // change may reset media identity and the per-ad retry limits.
    if (location.href !== navigationHref) {
      navigationHref = location.href;
      detachPlayer();
    }
    applySettings(settings);
  }
  for (const name of ["yt-navigate-finish", "yt-page-data-updated"]) {
    document.addEventListener(name, onNavigation);
  }
  window.addEventListener("popstate", onNavigation);
  chrome.storage.local.get("settings").then(
    (result) => {
      if (settingsRevision > 0) return;
      settingsLoaded = true;
      applySettings(result?.settings);
    },
    () => {
      if (settingsRevision === 0) {
        settingsLoaded = true;
        applySettings({ ...DEFAULT_SETTINGS, enabled: false });
      }
    },
  );
})();
