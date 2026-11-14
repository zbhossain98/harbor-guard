/* Ad-segment fallback informed by the current public YouTube filter patterns.
 * Uses the player's own explicit SSAP ad marker and segment progress. It never
 * guesses from the title, video length alone, or an ordinary buffering state.
 * Media events trigger checks; there is no continuous timer or network access.
 */
(() => {
  'use strict';
  let enabled = window.__harborGuardYouTubeEnabled === true;
  let lastCheck = -Infinity;
  let lastNormal = null;
  let segment = null;
  let route = window.location.href;
  let actions = 0;
  const AD_MARKER = /^SSAP,\s*AD(?:[,\s]|$)/;

  function inspect(event) {
    if (!enabled) return;
    const now = performance.now();
    if (event?.type === 'timeupdate' && now - lastCheck < 500) return;
    lastCheck = now;
    if (route !== window.location.href) {
      route = window.location.href;
      lastNormal = null;
      segment = null;
      actions = 0;
    }
    try {
      const player = document.querySelector('#movie_player');
      const video = player?.querySelector('video');
      if (!video || !video.isConnected || (event?.target && event.target !== video)) return;
      if (typeof player.getStatsForNerds !== 'function' || typeof player.getProgressState !== 'function'
        || typeof player.seekTo !== 'function') return;
      const stats = player.getStatsForNerds();
      const progress = player.getProgressState();
      if (!progress || !Number.isFinite(progress.duration) || !Number.isFinite(progress.current)) return;
      const source = video.currentSrc || '';
      if (typeof stats?.debug_info !== 'string' || !AD_MARKER.test(stats.debug_info)) {
        lastNormal = { video, source, duration: progress.duration };
        segment = null;
        return;
      }
      if (actions >= 16 || video.paused || video.ended || video.seeking || video.readyState < 2
        || progress.duration <= 0.5 || progress.duration > 600 || progress.current < 0
        || progress.current >= progress.duration - 0.25 || player.getPlayerState?.() !== 1) return;
      // A mid-roll marker can appear before the normal timeline is replaced.
      // Wait for changed media or a changed segment duration in that case.
      if (lastNormal?.video === video && lastNormal.source === source
        && Math.abs(lastNormal.duration - progress.duration) < 0.5) return;
      if (!segment || segment.video !== video || segment.source !== source
        || Math.abs(segment.duration - progress.duration) > 0.5
        || progress.current < segment.previous - 1) {
        segment = { video, source, duration: progress.duration, attempts: 0, at: -Infinity, previous: progress.current };
      }
      segment.previous = progress.current;
      if (segment.attempts >= 2 || now - segment.at < 1500) return;
      // Recheck immediately before seeking; page APIs can synchronously change
      // the active media while their state is read.
      const freshStats = player.getStatsForNerds();
      const freshProgress = player.getProgressState();
      if (!enabled || !AD_MARKER.test(freshStats?.debug_info || '')
        || player.querySelector('video') !== video || (video.currentSrc || '') !== source
        || video.paused || video.seeking || video.ended || video.readyState < 2 || player.getPlayerState?.() !== 1
        || freshProgress?.duration !== progress.duration || !Number.isFinite(freshProgress.current) || freshProgress.current < 0
        || freshProgress.current >= progress.duration - 0.25) return;
      segment.attempts += 1;
      segment.at = now;
      actions += 1;
      player.seekTo(progress.duration, true);
    } catch {
      // Unsupported/protected player APIs and failed seeks leave playback alone.
    }
  }

  for (const type of ['timeupdate', 'playing', 'loadedmetadata', 'durationchange']) {
    document.addEventListener(type, inspect, true);
  }
  document.addEventListener('harbor-guard:youtube-config', (event) => {
    if (typeof event.detail?.enabled !== 'boolean') return;
    enabled = event.detail.enabled;
    if (!enabled) { lastNormal = null; segment = null; }
  });
})();
