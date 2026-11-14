/* Origin-scoped messages contain playback state and current public media URLs.
 * Native code validates all messages and requires a user action for downloads. */
(() => {
  'use strict';
  // Keep YouTube's own layout and controls, with colours matching the native shell.
  if (typeof MutationObserver === 'function') {
    const applyTheme = () => {
      if (!document.documentElement) return false;
      if (document.getElementById('harbortube-theme')) return true;
      const style = document.createElement('style'); style.id = 'harbortube-theme';
      style.textContent = `html,body{color-scheme:dark;--yt-spec-base-background:#0f0f0f!important;--yt-spec-raised-background:#181818!important;--yt-spec-menu-background:#181818!important;--yt-spec-text-primary:#f1f1f1!important;--yt-spec-text-secondary:#aaa!important;--yt-spec-badge-chip-background:#272727!important;--yt-spec-general-background-a:#0f0f0f!important;--yt-spec-general-background-b:#181818!important;color:#f1f1f1!important;background:#0f0f0f!important}ytm-app,ytm-browse,ytm-watch,ytm-mobile-topbar-renderer{background:var(--yt-spec-base-background)!important}video{background:#000}`;
      document.documentElement.appendChild(style); return true;
    };
    if (!applyTheme()) { const observer = new MutationObserver(() => { if (applyTheme()) observer.disconnect(); }); observer.observe(document, { childList: true }); }
  }
  const bridge = window.harborTube;
  if (!bridge || typeof bridge.postMessage !== 'function') return;
  let background = false, details = false, latest = null, lastId = '', lastState = '', lastSent = 0, ducked = null;
  const seen = new WeakSet();
  const pending = new Map(), streams = new Set();
  const send = value => { try { bridge.postMessage(JSON.stringify(value)); } catch {} };
  const id = () => new URL(location.href).searchParams.get('v') || location.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1] || '';
  function capture(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 12)) capture(item, depth + 1); return; }
    if (value.videoDetails?.videoId && value.streamingData) {
      if (seen.has(value)) return;
      seen.add(value);
      const formats = [...(value.streamingData.formats || []), ...(value.streamingData.adaptiveFormats || [])];
      const result = { type: 'formats', id: value.videoDetails.videoId, title: String(value.videoDetails.title || '').slice(0, 200),
        formats: formats.filter(f => /(?:avc1|mp4a|vp9|vp09|opus|vorbis)/i.test(f.mimeType || '')).slice(0, 40).map(f => {
          let url = f.url || ''; const cipher = f.signatureCipher || f.cipher;
          if (!url && cipher) url = new URLSearchParams(cipher).get('url') || '';
          let resolved = false;
          try { resolved = Boolean(f.url && !new URL(url).searchParams.has('n')); } catch {}
          return { url, resolved, itag: f.itag || 0, mime: f.mimeType || '', height: f.height || 0, bitrate: f.bitrate || 0,
            combined: Boolean(f.audioQuality || f.audioChannels) && String(f.mimeType).startsWith('video/') };
        }) };
      pending.set(result.id, result); if (pending.size > 3) pending.delete(pending.keys().next().value);
      if (result.id === id()) { latest = result; send(latest); }
    }
    for (const key of ['playerResponse', 'player_response', 'response', 'responses', 'responseContext']) {
      const nested = value[key];
      if (typeof nested === 'string' && key === 'player_response') { try { capture(JSON.parse(nested), depth + 1); } catch {} }
      else capture(nested, depth + 1);
    }
  }
  const isAd = () => /(?:^|\s)ad-(showing|interrupting)(?:\s|$)/.test(document.querySelector('#movie_player')?.className || '');
  function observeStream(value, videoId = id()) {
    if (!videoId || videoId !== id() || isAd()) return;
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') || url.pathname !== '/videoplayback') return;
      // The real playback URL has already gone through YouTube's signature and
      // throttling transforms. Do not guess or alter those transforms here.
      const identity = new URL(url.href);
      for (const key of ['range', 'rn', 'rbuf']) identity.searchParams.delete(key);
      const key = videoId + ':' + identity.href;
      if (streams.has(key)) return;
      if (streams.size >= 80) streams.delete(streams.values().next().value);
      streams.add(key); send({ type: 'stream', id: videoId, url: url.href });
    } catch {}
  }
  function readPlayer() {
    try {
      capture(window.ytInitialPlayerResponse); capture(window.ytplayer?.config?.args);
      const player = document.querySelector('#movie_player');
      if (typeof player?.getPlayerResponse === 'function') capture(player.getPlayerResponse());
      if (typeof player?.getVideoData === 'function') {
        const data = player.getVideoData();
        if (data?.video_id === id() && data.title && latest?.id === id()) latest.title = String(data.title).slice(0, 200);
      }
      const current = pending.get(id());
      if (current && latest !== current) { latest = current; send(latest); }
      const video = document.querySelector('#movie_player video') || document.querySelector('video');
      if (video?.currentSrc) observeStream(video.currentSrc);
    } catch {}
  }
  // Media loaded by Chromium's video pipeline can bypass page fetch/XHR.
  // Observe newly completed resources only, so earlier SPA videos are excluded.
  if (typeof PerformanceObserver === 'function') try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.startTime >= navigationTime) observeStream(entry.name);
      }
    });
    observer.observe({ type: 'resource', buffered: false });
  } catch {}
  let navigationTime = performance.now();
  // This observer only reads response clones; it never consumes the player's body.
  const fetch = window.fetch;
  if (typeof fetch === 'function') window.fetch = function (...args) {
    const videoId = id();
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    const result = Reflect.apply(fetch, this, args);
    result.then(response => {
      try {
        if (!response.ok) return;
        observeStream(requestUrl, videoId);
        const url = new URL(response.url);
        observeStream(response.url, videoId);
        if (/(^|\.)youtube\.com$/.test(url.hostname) && /\/youtubei\/v1\/(player|get_watch|next|playlist)$/.test(url.pathname)) {
          response.clone().json().then(capture).catch(() => {});
        }
      } catch {}
    }, () => {});
    return result;
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    const result = Reflect.apply(xhrOpen, this, args);
    const videoId = id(), requestUrl = args[1];
    this.addEventListener('load', () => { if (this.status >= 200 && this.status < 300) observeStream(requestUrl, videoId); }, { once: true });
    let endpoint = false;
    try { const u = new URL(args[1], location.href); endpoint = /(^|\.)youtube\.com$/.test(u.hostname) && /\/youtubei\/v1\/(player|get_watch|next|playlist)$/.test(u.pathname); } catch {}
    if (endpoint) this.addEventListener('load', () => { try { capture(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch {} }, { once: true });
    return result;
  };
  for (const [name, active] of [['hidden', false], ['visibilityState', 'visible']]) {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, name);
    if (descriptor?.get) try { Object.defineProperty(document, name, { configurable: true,
      get() { return background ? active : descriptor.get.call(this); } }); } catch {}
  }
  document.addEventListener('visibilitychange', event => { if (background) event.stopImmediatePropagation(); }, true);
  window.__harborTubeAction = (action, value) => {
    if (action === 'background') { background = value === true; if (background) state(true); return; }
    if (action === 'details') { details = value === true; if (details) state(true); return; }
    if (action === 'refresh') {
      state(true); document.dispatchEvent(new CustomEvent('harbortube:navigate')); return;
    }
    if (action === 'formats') { readPlayer();
      if (latest?.id === id()) send(latest); return; }
    const video = document.querySelector('#movie_player video') || document.querySelector('video');
    if (!video) return;
    if (action === 'play') video.play().catch(() => {});
    if (action === 'pause') video.pause();
    if (action === 'toggle') { if (video.paused) video.play().catch(() => {}); else video.pause(); }
    if (action === 'seek' && Number.isFinite(value) && Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, value));
    if (action === 'duck') { if (!ducked || ducked.video !== video) ducked = { video, volume: video.volume }; video.volume = ducked.volume * 0.2; }
    if (action === 'restoreVolume') { if (ducked?.video === video) video.volume = ducked.volume; ducked = null; }
    state(true);
  };
  function state(force = false) {
    const currentId = id();
    if (currentId !== lastId) {
      lastId = currentId; navigationTime = performance.now(); if (latest?.id !== currentId) latest = null; lastState = '';
      readPlayer();
    }
    const video = document.querySelector('#movie_player video') || document.querySelector('video');
    const player = document.querySelector('#movie_player');
    const isAd = player && /(?:^|\s)ad-(showing|interrupting)(?:\s|$)/.test(player.className);
    const message = { type: 'state', id: currentId, title: String(document.title || 'HarborTube').replace(/ - YouTube$/, '').slice(0, 200),
      position: video && Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: video && Number.isFinite(video.duration) ? video.duration : 0,
      playing: Boolean(video && !video.paused && !video.ended), ad: Boolean(isAd) };
    const key = JSON.stringify(message);
    const now = performance.now();
    if (force || key !== lastState && now - lastSent > 1000) { lastState = key; lastSent = now; send(message); }
  }
  for (const event of ['play', 'pause', 'ended', 'yt-navigate-finish']) document.addEventListener(event, () => state(true), true);
  document.addEventListener('loadedmetadata', () => { readPlayer(); state(true); }, true);
  // Ordinary foreground playback sends changes only. Metadata extraction and
  // native progress updates are unnecessary while YouTube owns the controls.
  setInterval(() => { if (background || details) state(); }, 2000);
  state(true);
})();
