import { createRequire } from 'node:module';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Optional live diagnostic, separate from repeatable fixture tests. Uses only a
// fresh project-local profile. Ad delivery varies; no observed ad is no proof
// that blocking succeeds for signed-in users or every YouTube rollout.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.HARBOR_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const selectedIndex = process.argv.indexOf('--video');
const selectedVideo = selectedIndex >= 0 ? process.argv[selectedIndex + 1] : null;
if (selectedIndex >= 0 && !/^[A-Za-z0-9_-]{11}$/.test(selectedVideo || '')) throw new Error('--video requires an 11-character public YouTube video ID.');
await mkdir(path.join(root, '.cache'), { recursive: true });
const profile = await mkdtemp(path.join(root, '.cache', 'youtube-live-'));
const extension = path.join(root, 'extension');
const browser = await chromium.launchPersistentContext(profile, {
  ...(process.env.HARBOR_BROWSER_PATH ? { executablePath: process.env.HARBOR_BROWSER_PATH } : {}),
  headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 15000 });
  const id = await worker.evaluate(() => chrome.runtime.id);
  const controls = await browser.newPage();
  await controls.goto(`chrome-extension://${id}/dashboard.html`);
  const state = await controls.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }));
  if (!state.ok || state.state.warning) throw new Error(JSON.stringify(state));
  const baseline = process.argv.includes('--baseline');
  if (baseline) {
    const paused = await controls.evaluate(() => chrome.runtime.sendMessage({ type: 'updateSettings', patch: { enabled: false } }));
    if (!paused.ok) throw new Error(JSON.stringify(paused));
  }
  const page = await browser.newPage();
  const results = [];
  for (const video of selectedVideo ? [selectedVideo] : process.argv.includes('--error-only') ? ['dQw4w9WgXc'] : ['dQw4w9WgXc', 'aqz-KE-bpKQ']) {
    console.log(`Checking public video ${video} with protection ${baseline ? 'paused' : 'enabled'} in a signed-out test profile…`);
    try {
      await page.goto(`https://www.youtube.com/watch?v=${video}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      const reject = page.getByRole('button', { name: /^Reject all$/i });
      if (await reject.count()) await reject.first().click({ timeout: 3000 });
      const play = page.locator('.ytp-large-play-button');
      if (await play.count()) await play.first().click({ timeout: 3000 }).catch(() => {});
      const samples = [];
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(3000);
        samples.push(await page.evaluate(() => {
          const player = document.querySelector('#movie_player');
          const video = player?.querySelector('video');
          const response = window.ytInitialPlayerResponse;
          let stats;
          let progress;
          try { stats = player?.getStatsForNerds?.(); progress = player?.getProgressState?.(); } catch {}
          const text = document.body.innerText;
          return {
            adState: !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')),
            time: video?.currentTime ?? null, paused: video?.paused ?? null,
            playability: response?.playabilityStatus?.status ?? null,
            playbackReason: response?.playabilityStatus?.reason ?? null,
            initialAdFields: ['adPlacements', 'adSlots', 'playerAds'].filter((key) => response?.[key] !== undefined),
            blockedByBotCheck: /confirm you.re not a bot/i.test(text),
            antiAdblockNotice: /ad blockers violate|allow YouTube ads|turn off your ad blocker/i.test(text),
            statsAvailable: typeof stats?.debug_info === 'string',
            ssapAd: /^SSAP,\s*AD(?:[,\s]|$)/.test(stats?.debug_info || ''),
            segmentDuration: progress?.duration ?? null,
          };
        }));
      }
      results.push({ video, samples });
      console.log(JSON.stringify(results.at(-1)));
    } catch (error) {
      results.push({ video, error: error.message });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  console.log('Live diagnostic complete. This does not establish universal ad blocking.');
} finally {
  await browser.close();
}
