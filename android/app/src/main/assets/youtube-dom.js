/* YouTube-only DOM fallback. CSS hides ad slots without repeated page scans;
 * only the mounted player's mutations and media events trigger ad checks. */
(() => {
  'use strict';
  if (window.__harborTubeDomReady) return;
  window.__harborTubeDomReady = true;
  const ad = /(?:^|\s)ad-(?:showing|interrupting)(?:\s|$)/;
  const selectors = 'ytd-ad-slot-renderer,ytd-display-ad-renderer,ytd-promoted-video-renderer,ytm-ad-slot-renderer,ytm-promoted-sparkles-web-renderer,ytm-companion-ad-renderer,#player-ads';
  const skipSelectors = '.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button';
  let timer = null, discovery = null, watched = null, playerObserver = null;
  let attempts = 0, acted = -Infinity, lastNormal = null, segment = null;
  let route = location.href;
  function style() {
    if (!document.documentElement) return;
    if (document.getElementById('harbortube-ad-slots')) return;
    const node = document.createElement('style'); node.id = 'harbortube-ad-slots';
    node.textContent = selectors + '{display:none!important}'; document.documentElement.appendChild(node);
  }
  function visible(node) { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden'; }
  function attach() {
    style();
    const player = document.querySelector('#movie_player');
    if (player === watched && player?.isConnected) return player;
    playerObserver?.disconnect(); playerObserver = null; watched = player;
    if (player) {
      discovery?.disconnect(); discovery = null;
      playerObserver = new MutationObserver(schedule);
      playerObserver.observe(player, { attributes: true, attributeFilter: ['class'], childList: true });
    } else if (!discovery && (/\/watch(?:\?|$)/.test(location.href) || location.pathname.startsWith('/shorts/'))) {
      discovery = new MutationObserver(schedule);
      discovery.observe(document, { childList: true, subtree: true });
    }
    return player;
  }
  function check() {
    timer = null;
    if (route !== location.href) {
      route = location.href; attempts = 0; lastNormal = null; segment = null;
      discovery?.disconnect(); discovery = null;
    }
    const player = attach();
    const video = player?.querySelector('video');
    if (!video) return;
    const current = { video, source: video.currentSrc, duration: video.duration };
    if (!ad.test(player.className)) { lastNormal = current; segment = null; return; }
    const now = performance.now();
    if (!segment || segment.video !== video || segment.source !== current.source || Math.abs(segment.duration - video.duration) > .5) {
      segment = { ...current, seeks: 0, clicks: 0, start: now };
    }
    if (attempts >= 16 || now - segment.start > 120000) return;
    if (now - acted >= 1500) {
      const button = [...player.querySelectorAll(skipSelectors)].find((node) => !node.disabled && visible(node));
      if (button && segment.clicks < 4) {
        segment.clicks++; attempts++; acted = now;
        try { button.click(); } catch {}
      } else if (segment.seeks < 2 && now - segment.start > 350 && !video.paused && !video.seeking && !video.ended
        && video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > .5 && video.duration <= 600
        && video.currentTime < video.duration - .25
        && (!lastNormal || lastNormal.video !== video || lastNormal.source !== current.source || Math.abs(lastNormal.duration - video.duration) > .5)
        && [...player.querySelectorAll('.ytp-ad-text,.ytp-ad-duration-remaining,.ytp-ad-player-overlay')].some(visible)) {
        segment.seeks++; attempts++; acted = now;
        try { video.currentTime = video.duration; } catch {}
      }
    }
    if (ad.test(player.className)) timer = setTimeout(check, 400);
  }
  function schedule() { if (timer === null) timer = setTimeout(check, 100); }
  for (const event of ['playing', 'loadedmetadata', 'durationchange', 'yt-navigate-finish', 'harbortube:navigate']) document.addEventListener(event, schedule, true);
  document.addEventListener('DOMContentLoaded', schedule, { once: true });
  schedule();
})();