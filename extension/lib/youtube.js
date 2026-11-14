import { isSiteAllowed } from './settings.js';

export const YOUTUBE_SCRIPT_ID = 'harbor-guard-youtube-player';
export const YOUTUBE_SCRIPT_FILES = ['content/youtube-bootstrap.js', 'content/youtube-compat.js', 'content/youtube-recovery.js', 'content/youtube-runtime.js', 'content/youtube-player.js'];
const HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];

// Persisted registrations let Chrome inject before inline page scripts, without
// waiting for the service worker or an asynchronous storage read on each page.
export async function applyYouTubeSettings(scripting, settings) {
  const matches = settings.enabled && settings.youtube
    ? HOSTS.filter((host) => !isSiteAllowed(host, settings.siteAllowlist)).map((host) => `https://${host}/*`)
    : [];
  const registered = await scripting.getRegisteredContentScripts({ ids: [YOUTUBE_SCRIPT_ID] });
  if (!matches.length) {
    if (registered.length) await scripting.unregisterContentScripts({ ids: [YOUTUBE_SCRIPT_ID] });
    return;
  }
  const script = {
    id: YOUTUBE_SCRIPT_ID, matches, js: [...YOUTUBE_SCRIPT_FILES],
    runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true,
  };
  if (registered.length) await scripting.updateContentScripts([script]);
  else await scripting.registerContentScripts([script]);
}
