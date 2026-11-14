/*
 * Recover the specific YouTube ad-block playability error using the native
 * player. Error recognition and WEB playback contexts are informed by uAssets
 * Quick fixes. This is an independent, bounded implementation, not a filter
 * interpreter. It never removes an error screen or changes account identity.
 */
(() => {
  'use strict';
  const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
  if (window.location.protocol !== 'https:' || window.location.port || !hosts.has(window.location.hostname)) return;

  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const modes = ['channel', 'inline'];
  const retryDelay = 4000;
  let enabled = window.__harborGuardYouTubeEnabled === true;
  let videoId = null;
  let attempts = 0;
  let mode = null;
  let phase = 'idle';
  let lastAttempt = -Infinity;
  let position = null;
  let paused = false;
  let playlist = null;
  let retryTimer = null;
  let scanTimer = null;
  let installed = false;
  let lastMediaCheck = -Infinity;

  function announce() {
    document.dispatchEvent(new CustomEvent('harbor-guard:youtube-recovery-ready', {
      detail: { installed, phase, attempts },
    }));
  }
  function cancelRetry() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }
  function currentVideo() {
    const url = new URL(window.location.href);
    const id = url.pathname === '/watch' ? url.searchParams.get('v') : null;
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
  }
  function syncVideo() {
    const next = currentVideo();
    if (next !== videoId) {
      cancelRetry();
      videoId = next;
      attempts = 0;
      mode = null;
      phase = 'idle';
      position = null;
      paused = false;
      playlist = null;
      lastAttempt = -Infinity;
    }
    return next;
  }

  function hasAdblockHelp(value, depth = 0, budget = { left: 150 }) {
    if (!value || typeof value !== 'object' || depth > 10 || --budget.left < 0) return false;
    // Inspect data properties only. Renderer callbacks/getters are never run.
    for (const key of Object.keys(value).slice(0, 50)) {
      const child = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (key === 'url' && typeof child === 'string') {
        try {
          const url = new URL(child);
          if (url.protocol === 'https:' && url.hostname === 'support.google.com' && !url.port
            && url.pathname === '/youtube/answer/3037019') return true;
        } catch { /* Not a URL in a supported error renderer. */ }
      }
      if (hasAdblockHelp(child, depth + 1, budget)) return true;
    }
    return false;
  }
  function isAdblockError(response) {
    const status = response?.playabilityStatus;
    if (status?.status !== 'UNPLAYABLE') return false;
    const screen = status.errorScreen;
    if (screen?.playerErrorMessageRenderer?.playerCaptchaViewModel) return false;
    return hasAdblockHelp(screen?.playerErrorMessageRenderer?.subreason)
      || hasAdblockHelp(screen?.playerInterstitialRenderer?.content);
  }
  function playerEndpoint(input) {
    try {
      const url = new URL(typeof input === 'string' ? input : input?.url || input?.href, window.location.href);
      return url.protocol === 'https:' && !url.port && hosts.has(url.hostname) && url.pathname === '/youtubei/v1/player';
    } catch { return false; }
  }
  function rewriteBody(body) {
    if (!enabled || !syncVideo() || !mode || typeof body !== 'string' || body.length > 2_000_000) return body;
    try {
      const data = Reflect.apply(parse, JSON, [body]);
      if (!data || data.videoId !== videoId || data.context?.client?.clientName !== 'WEB') return body;
      // Copy through JSON: the page's objects, credentials, attestation, user
      // agent, client identity, playlist parameters and signatures stay intact.
      if (mode === 'channel') data.context.client.clientScreen = 'CHANNEL';
      else {
        if (!data.playbackContext || typeof data.playbackContext !== 'object' || Array.isArray(data.playbackContext)
          || !data.playbackContext.contentPlaybackContext || typeof data.playbackContext.contentPlaybackContext !== 'object'
          || Array.isArray(data.playbackContext.contentPlaybackContext)) return body;
        data.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd = true;
      }
      return Reflect.apply(stringify, JSON, [data]);
    } catch { return body; }
  }
  function withBody(init, body) {
    // Retain RequestInit fields (including signal and headers) without invoking
    // getters just to copy them. Native fetch still interprets those fields.
    const descriptors = init ? Object.getOwnPropertyDescriptors(init) : {};
    descriptors.body = { configurable: true, enumerable: true, writable: true, value: body };
    return Object.create(init ? Object.getPrototypeOf(init) : Object.prototype, descriptors);
  }

  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = new Proxy(nativeFetch, {
        apply(target, receiver, args) {
          const forward = (next = args) => Reflect.apply(target, receiver, next);
          if (!enabled || !mode || !playerEndpoint(args[0])) return forward();
          let next = args;
          try {
            const input = args[0];
            const init = args[1];
            const request = typeof window.Request === 'function' && input instanceof window.Request;
            const method = Object.getOwnPropertyDescriptor(init || {}, 'method')?.value ?? (request ? input.method : 'GET');
            if (typeof method === 'string' && method.toUpperCase() === 'POST') {
              const bodyDescriptor = Object.getOwnPropertyDescriptor(init || {}, 'body');
              if (bodyDescriptor && 'value' in bodyDescriptor) {
                const body = rewriteBody(bodyDescriptor.value);
                if (body !== bodyDescriptor.value) next = [input, withBody(init, body), ...args.slice(2)];
              } else if (!bodyDescriptor && request && !input.bodyUsed && !input.signal.aborted
                && /^application\/json\b/i.test(input.headers.get('content-type') || '')) {
                // Read a clone only during recovery; normal Request/stream inputs
                // retain native timing. A failed read forwards the original once.
                return input.clone().text().then((raw) => {
                  const body = rewriteBody(raw);
                  return body === raw ? forward() : forward([input, withBody(init, body), ...args.slice(2)]);
                }, () => forward());
              }
            }
          } catch { /* Unfamiliar inputs are left for native fetch to validate. */ }
          // Native failures must escape this inspection catch without retrying.
          return forward(next);
        },
      });
      installed = true;
    }
  } catch { /* A protected fetch API must remain usable. */ }
  try {
    const prototype = window.XMLHttpRequest?.prototype;
    const open = prototype && Object.getOwnPropertyDescriptor(prototype, 'open');
    const send = prototype && Object.getOwnPropertyDescriptor(prototype, 'send');
    if (open?.writable && send?.writable && typeof open.value === 'function' && typeof send.value === 'function') {
      const requests = new WeakMap();
      Object.defineProperties(prototype, {
        open: { ...open, value: new Proxy(open.value, { apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          requests.set(receiver, typeof args[0] === 'string' && args[0].toUpperCase() === 'POST' && playerEndpoint(args[1]));
          return result;
        } }) },
        send: { ...send, value: new Proxy(send.value, { apply(target, receiver, args) {
          if (requests.get(receiver) && args.length) args[0] = rewriteBody(args[0]);
          return Reflect.apply(target, receiver, args);
        } }) },
      });
      installed = true;
    }
  } catch { /* Protected XHR APIs retain their native behavior. */ }

  function startPosition(response) {
    if (position !== null) return position;
    const configured = response?.playerConfig?.playbackStartConfig?.startSeconds;
    if (Number.isFinite(configured) && configured >= 0) return configured;
    const url = new URL(window.location.href);
    const time = url.searchParams.get('t') || url.searchParams.get('start') || '0';
    if (/^\d+(?:\.\d+)?s?$/.test(time)) return parseFloat(time);
    const parts = time.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return parts ? Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0) : 0;
  }
  function scheduleRetry(delay = retryDelay) {
    if (!enabled || retryTimer !== null) return;
    retryTimer = setTimeout(() => { retryTimer = null; inspect(); }, delay);
  }
  function inspect(event) {
    if (!enabled || !installed) return;
    if (event?.type === 'timeupdate') {
      if (performance.now() - lastMediaCheck < 500) return;
      lastMediaCheck = performance.now();
    }
    try {
      if (!syncVideo()) return;
      const player = document.querySelector('#movie_player');
      const response = player?.getPlayerResponse?.();
      if (!response || (response.videoDetails?.videoId && response.videoDetails.videoId !== videoId)) return;
      if (response.playabilityStatus?.status === 'OK') {
        cancelRetry();
        if (phase !== 'idle') { phase = 'idle'; announce(); }
        if (playlist && player.getPlaylistId?.() === null) {
          playlist.manager.setPlaylistData?.(playlist.data);
          playlist.manager.setPlayerPlaybackControlData?.({ playlistPanelRenderer: playlist.data });
        }
        playlist = null;
        const ad = /(?:^|\s)ad-(?:showing|interrupting)(?:\s|$)/.test(player.className || '')
          || /^SSAP,\s*AD(?:[,\s]|$)/.test(player.getStatsForNerds?.()?.debug_info || '');
        if (!ad && event?.target === player.querySelector?.('video') && ['playing', 'pause', 'timeupdate'].includes(event.type)) {
          const time = player.getCurrentTime?.();
          if (Number.isFinite(time) && time >= 0) position = time;
          if (['playing', 'pause'].includes(event.type)) paused = event.type === 'pause';
        }
        return;
      }
      if (!isAdblockError(response)) { cancelRetry(); mode = null; phase = 'idle'; announce(); return; }
      const remaining = retryDelay - (performance.now() - lastAttempt);
      if (remaining > 0) { scheduleRetry(remaining); return; }
      if (attempts >= modes.length) { cancelRetry(); phase = 'exhausted'; announce(); return; }
      const method = paused || player.getPlayerState?.() === 2 ? 'cueVideoById' : 'loadVideoById';
      if (typeof player[method] !== 'function') return;
      if (!playlist && new URL(window.location.href).searchParams.has('list')) {
        const manager = document.querySelector('yt-playlist-manager');
        const data = manager?.getPlaylistData?.();
        if (data) playlist = { manager, data };
      }
      const start = startPosition(response);
      if (!enabled || currentVideo() !== videoId || !Number.isFinite(start) || start < 0) return;
      mode = modes[attempts++];
      position = start;
      lastAttempt = performance.now();
      phase = 'retrying';
      announce();
      // Native reloads use the new request context; never fake an OK response.
      try { player[method](videoId, start); }
      finally { scheduleRetry(); }
    } catch { /* A replaced/unsupported player is left alone. */ }
  }
  function scheduleInspect() {
    if (!enabled || !document.documentElement || !currentVideo() || scanTimer !== null) return;
    scanTimer = setTimeout(() => { scanTimer = null; inspect(); }, 250);
  }
  const playerUI = '#movie_player,#player-error-message-container,yt-playability-error-supported-renderers';
  const observer = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
    if (records.some((record) => record.target?.closest?.(playerUI)
      || [...record.addedNodes].some((node) => node.matches?.(playerUI) || node.querySelector?.(playerUI)))) scheduleInspect();
  }) : null;
  function observe() {
    if (enabled) observer?.observe(document, { childList: true, subtree: true });
    else {
      observer?.disconnect();
      cancelRetry();
      if (scanTimer !== null) clearTimeout(scanTimer);
      scanTimer = null;
      mode = null;
      phase = 'idle';
    }
  }
  document.addEventListener('harbor-guard:youtube-config', (event) => {
    if (typeof event.detail?.enabled !== 'boolean') return;
    enabled = event.detail.enabled;
    observe();
    if (enabled) scheduleInspect();
    announce();
  });
  document.addEventListener('harbor-guard:youtube-status-request', announce);
  for (const name of ['DOMContentLoaded', 'yt-navigate-finish', 'yt-page-data-updated']) document.addEventListener(name, inspect);
  for (const name of ['playing', 'pause', 'error', 'timeupdate']) document.addEventListener(name, inspect, true);
  observe();
  announce();
})();
