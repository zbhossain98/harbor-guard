import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Uses a fresh, project-local profile and fulfilled test responses. No personal
// browser profile, account, browsing history, or live YouTube ad is accessed.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.HARBOR_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, '.cache'), { recursive: true });
const profile = await mkdtemp(path.join(root, '.cache', 'browser-smoke-'));
const extension = path.join(root, 'extension');
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
const probes = {};
for (const kind of ['ads', 'trackers']) {
  const rules = JSON.parse(await readFile(path.join(extension, 'rules', `${kind}.json`), 'utf8'));
  const domain = rules.find((rule) => rule.action.type === 'block' && rule.condition.requestDomains)?.condition.requestDomains[0];
  assert.ok(domain);
  probes[kind] = { url: `https://${domain}/harbor-fixture.js`, type: 'script', initiator: 'https://publisher.example' };
}
const data = {
  adPlacements: [{ id: 'ad' }], adSlots: [{ id: 'slot' }], playerAds: [{ id: 'player-ad' }],
  videoDetails: { videoId: 'fixture', lengthSeconds: '300' },
  playabilityStatus: { status: 'OK' },
  streamingData: { formats: [{ url: 'https://media.example/keep' }] },
  captions: { language: 'en' }, unrelated: { adSlots: ['keep'] },
};
const raw = JSON.stringify(data);
const html = `<!doctype html><meta charset="utf-8"><title>Harbor Guard test fixture</title>
<script>
  window.fixtureWarningShown = false;
  window.fixtureDetector = { onAbnormalityDetected() { window.fixtureWarningShown = true; } };
  window.fixtureWarningProbe = Promise.resolve().then(() => window.fixtureDetector.onAbnormalityDetected());
  window.fixtureNormalPromise = Promise.resolve(21).then(value => value * 2);
  var ytInitialPlayerResponse = ${raw};
  window.inlineHadAds = window.ytInitialPlayerResponse.adPlacements !== undefined;
  window.ytInitialPlayerResponse.adPlacements = [{ id: 'late-reinsertion' }];
  window.reinsertedAds = window.ytInitialPlayerResponse.adPlacements !== undefined;
  window.parsedPlayer = JSON.parse(${JSON.stringify(raw)});
</script><p>Controlled YouTube player fixture</p><div id="movie_player"><video></video></div>`;
const errors = [];
const recoveryRequests = [];
const recoveryId = 'abcdefghijk';
const recoveryBody = { videoId: recoveryId, context: { client: { clientName: 'WEB', clientScreen: 'WATCH', userAgent: 'keep-agent' } },
  attestationRequest: { omitBotguardData: false }, playbackContext: { contentPlaybackContext: { signatureTimestamp: 12345 } } };
const recoveryError = { videoDetails: { videoId: recoveryId }, playabilityStatus: { status: 'UNPLAYABLE', errorScreen: {
  playerErrorMessageRenderer: { subreason: { runs: [{ navigationEndpoint: { commandMetadata: { webCommandMetadata: {
    url: 'https://support.google.com/youtube/answer/3037019', webPageType: 'WEB_PAGE_TYPE_UNKNOWN',
  } } } }] } },
} } };
const recoveryHtml = `<!doctype html><meta charset="utf-8"><title>YouTube recovery fixture</title>
<div id="movie_player"><video></video></div><script>
  window.recoveryLoads = [];
  window.recoveryResponse = { videoDetails: { videoId: '${recoveryId}' }, playabilityStatus: { status: 'OK' } };
  window.recoveryTriggered = false;
  const player = document.querySelector('#movie_player');
  player.getPlayerResponse = () => window.recoveryResponse;
  player.getPlayerState = () => 1;
  player.getCurrentTime = () => 90;
  player.loadVideoById = (id, start) => {
    window.recoveryLoads.push([id, start]);
    window.recoveryPending = fetch('/youtubei/v1/player?recovery', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(recoveryBody)})
    }).then(response => response.json()).then(value => {
      window.recoveryResponse = value;
      document.dispatchEvent(new CustomEvent('yt-page-data-updated'));
    });
  };
  setTimeout(() => {
    window.recoveryResponse = ${JSON.stringify(recoveryError)};
    window.recoveryTriggered = true;
    document.body.appendChild(document.createElement('yt-playability-error-supported-renderers'));
  }, 50);
</script>`;
async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.HARBOR_BROWSER_PATH ? { executablePath: process.env.HARBOR_BROWSER_PATH } : {}),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (url.hostname === 'www.youtube.com' && url.pathname === '/watch') {
      if (url.searchParams.has('recoveryFixture')) return route.fulfill({ contentType: 'text/html', body: recoveryHtml });
      if (url.searchParams.has('pbj')) {
        return route.fulfill({ contentType: 'application/json', body: ")]}'\n" + JSON.stringify([{ playerResponse: data }]) });
      }
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (url.hostname === 'www.youtube.com' && url.pathname === '/playlist') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ playerResponse: data }]) });
    }
    if (url.hostname === 'www.youtube.com' && url.pathname.startsWith('/youtubei/v1/')) {
      if (url.searchParams.has('recovery')) {
        recoveryRequests.push(route.request().postDataJSON());
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...data, videoDetails: { videoId: recoveryId } }) });
      }
      if (url.pathname === '/youtubei/v1/navigation/resolve_url') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ adSlots: ['navigation'], endpoint: {
          watchEndpoint: { videoId: 'fixture', unserializedPrefetchData: { playerResponse: data, nextResponse: { adSlots: ['keep'] } } },
        } }) });
      }
      const body = url.searchParams.has('nested') ? JSON.stringify([{ playerResponse: data }]) : raw;
      return route.fulfill({ status: url.searchParams.has('fail') ? 403 : 200, contentType: 'application/json', body });
    }
    return route.fulfill({ status: 204 });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = await worker.evaluate(() => chrome.runtime.id);
  const controls = await context.newPage();
  await controls.goto(`chrome-extension://${id}/dashboard.html`);
  const send = (message) => controls.evaluate((value) => chrome.runtime.sendMessage(value), message);
  const state = await send({ type: 'getState' });
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(state.state.warning, null);
  const page = await context.newPage();
  return { context, controls, page, send };
}
async function update(browser, message) {
  const reply = await browser.send(message);
  assert.equal(reply.ok, true, JSON.stringify(reply));
}
async function checkPage(browser, expectAds) {
  await browser.page.goto('https://www.youtube.com/watch?v=fixture');
  const initial = await browser.page.evaluate(async () => ({
    warningResult: await window.fixtureWarningProbe,
    warningShown: window.fixtureWarningShown,
    normalPromise: await window.fixtureNormalPromise,
    inline: window.inlineHadAds,
    reinserted: window.reinsertedAds,
    parsed: Object.hasOwn(window.parsedPlayer, 'adPlacements'),
    playback: window.ytInitialPlayerResponse.streamingData,
    captions: window.ytInitialPlayerResponse.captions,
    unrelated: window.ytInitialPlayerResponse.unrelated,
  }));
  assert.equal(initial.warningShown, expectAds, 'the known ad-block warning callback follows the helper setting');
  assert.equal(initial.normalPromise, 42, 'ordinary Promise callbacks still run');
  assert.equal(initial.inline, expectAds, 'inline script must see already-cleaned data');
  assert.equal(initial.reinserted, expectAds, 'later ad reinsertion on the initial object stays blocked');
  assert.equal(initial.parsed, expectAds, 'serialized initial player data');
  assert.deepEqual(initial.playback, data.streamingData);
  assert.deepEqual(initial.captions, data.captions);
  assert.deepEqual(initial.unrelated, data.unrelated);
  const results = await browser.page.evaluate(async () => {
    const xhr = (url, responseType = '') => new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', url);
      request.responseType = responseType;
      request.onerror = reject;
      request.onload = () => {
        if (responseType === 'json') {
          let errorName;
          try { void request.responseText; } catch (error) { errorName = error.name; }
          resolve({ value: request.response, errorName });
        } else {
          resolve({ value: JSON.parse(request.responseText), consistent: request.response === request.responseText });
        }
      };
      request.send('{"videoId":"fixture"}');
    });
    const fetched = await fetch('/youtubei/v1/player');
    const borrowedJson = await Response.prototype.json.call(await fetch('/youtubei/v1/player'));
    const borrowedText = await Response.prototype.text.call(await fetch('/youtubei/v1/player'));
    const bytes = await Response.prototype.arrayBuffer.call(await fetch('/youtubei/v1/player'));
    const blob = await Response.prototype.blob.call(await fetch('/youtubei/v1/player'));
    const cloned = Response.prototype.clone.call(await fetch('/youtubei/v1/player'));
    const watchText = await (await fetch('/watch?v=fixture&pbj=1')).text();
    const playlist = await (await fetch('/playlist?list=fixture&pbj=1')).json();
    const player = document.querySelector('#movie_player');
    const video = player.querySelector('video');
    const runtimeSeeks = [];
    Object.defineProperties(video, {
      paused: { value: false, configurable: true }, ended: { value: false, configurable: true },
      seeking: { value: false, configurable: true }, readyState: { value: 4, configurable: true },
    });
    player.getStatsForNerds = () => ({ debug_info: 'SSAP, AD' });
    player.getProgressState = () => ({ duration: 30, current: 2 });
    player.getPlayerState = () => 1;
    player.seekTo = (...args) => runtimeSeeks.push(args);
    video.dispatchEvent(new Event('playing'));
    return {
      fetchJson: await fetched.clone().json(), fetchText: JSON.parse(await fetched.text()),
      xhrText: await xhr('/youtubei/v1/player'), xhrJson: await xhr('/youtubei/v1/player', 'json'),
      nested: await (await fetch('/youtubei/v1/player?nested')).json(),
      prefetched: await (await fetch('/youtubei/v1/navigation/resolve_url')).json(),
      unrelated: await (await fetch('/youtubei/v1/next')).json(),
      failure: await xhr('/youtubei/v1/player?fail', 'json'),
      borrowedJson, borrowedText, bytesText: new TextDecoder().decode(bytes), blobText: await blob.text(),
      blobType: blob.type, nativeClone: await Response.prototype.json.call(cloned),
      watchText, playlist, runtimeSeeks,
    };
  });
  for (const value of [results.fetchJson, results.fetchText, results.xhrText.value, results.xhrJson.value, results.nested[0].playerResponse]) {
    assert.equal(Object.hasOwn(value, 'adPlacements'), expectAds);
    assert.equal(Object.hasOwn(value, 'adSlots'), expectAds);
    assert.equal(Object.hasOwn(value, 'playerAds'), expectAds);
    assert.deepEqual(value.streamingData, data.streamingData);
  }
  assert.equal(results.xhrText.consistent, true);
  assert.equal(results.xhrJson.errorName, 'InvalidStateError');
  assert.ok(results.unrelated.adPlacements);
  assert.ok(results.failure.value.adPlacements);
  assert.equal(Object.hasOwn(results.prefetched.endpoint.watchEndpoint.unserializedPrefetchData.playerResponse, 'adPlacements'), expectAds);
  assert.deepEqual(results.prefetched.adSlots, ['navigation']);
  assert.deepEqual(results.prefetched.endpoint.watchEndpoint.unserializedPrefetchData.nextResponse.adSlots, ['keep']);
  for (const value of [results.borrowedJson, results.nativeClone, results.playlist[0].playerResponse]) {
    assert.equal(Object.hasOwn(value, 'adPlacements'), expectAds);
  }
  for (const body of [results.borrowedText, results.bytesText, results.blobText, results.watchText]) {
    assert.equal(body.includes('"adPlacements"'), expectAds, 'raw text/bytes must be cleaned before JSON.parse');
  }
  assert.ok(results.watchText.startsWith(")]}'\n"), 'anti-XSSI guard survives');
  assert.equal(results.blobType, 'application/json');
  assert.deepEqual(results.runtimeSeeks, expectAds ? [] : [[30, true]], 'classless SSAP ad uses guarded native player seek');
  const tabId = await browser.controls.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === 'https://www.youtube.com/watch?v=fixture')?.id;
  });
  const status = await browser.controls.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'getPageProtectionStatus' }), tabId);
  assert.equal(status.version, manifest.version);
  assert.equal(status.settingsLoaded, true);
  assert.equal(status.youtubeEnabled, !expectAds);
  if (!expectAds) {
    assert.equal(status.youtubeMainReady, true);
    assert.equal(status.youtubeCompatReady, true);
    assert.equal(status.youtubeRecoveryReady, true);
  }
}

async function checkRecovery(browser, enabled) {
  recoveryRequests.length = 0;
  await browser.page.goto(`https://www.youtube.com/watch?v=${recoveryId}&t=90&recoveryFixture=1`);
  await browser.page.waitForFunction(() => window.recoveryTriggered);
  if (enabled) await browser.page.waitForFunction(() => window.recoveryResponse?.playabilityStatus?.status === 'OK');
  const state = await browser.page.evaluate(() => ({ loads: window.recoveryLoads, response: window.recoveryResponse }));
  assert.deepEqual(state.loads, enabled ? [[recoveryId, 90]] : []);
  assert.equal(state.response.playabilityStatus.status, enabled ? 'OK' : 'UNPLAYABLE');
  assert.equal(recoveryRequests.length, enabled ? 1 : 0);
  if (enabled) {
    const expected = structuredClone(recoveryBody); expected.context.client.clientScreen = 'CHANNEL';
    assert.deepEqual(recoveryRequests[0], expected, 'only the WEB playback context changes');
    assert.equal(Object.hasOwn(state.response, 'adPlacements'), false, 'recovery and response filtering compose');
    await browser.page.evaluate(async (body) => {
      await fetch(new Request(location.origin + '/youtubei/v1/player?recovery', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
    }, recoveryBody);
    assert.deepEqual(recoveryRequests.at(-1), expected, 'constructed Request bodies use the same recovery context');
  }
}

let browser;
try {
  browser = await launch();
  for (const kind of ['ads', 'trackers']) {
    const matches = () => browser.controls.evaluate((probe) => chrome.declarativeNetRequest.testMatchOutcome(probe), probes[kind]);
    assert.ok((await matches()).matchedRules.some((rule) => rule.rulesetId === kind), `${kind} rule engine must match a bundled domain`);
    await update(browser, { type: 'updateSettings', patch: { [kind]: false } });
    assert.equal((await matches()).matchedRules.some((rule) => rule.rulesetId === kind), false);
    await update(browser, { type: 'updateSettings', patch: { [kind]: true } });
  }
  console.log('PASS: actual browser rule-engine matches for bundled ad/tracker domains and independent layer toggles');
  await checkPage(browser, false);
  await checkRecovery(browser, true);
  console.log('PASS: specific playback-error recovery, preserved timestamp/identity, constructed Requests, and prefetched player data');
  console.log('PASS: early ad-block warning guard, initial data, fetch/XHR, borrowed Response methods, bytes/Blob, legacy watch/playlist, anti-XSSI, and classless SSAP ad fallback');
  for (const patch of [{ youtube: false }, { youtube: true, enabled: false }]) {
    await update(browser, { type: 'updateSettings', patch });
    await checkPage(browser, true);
    await checkRecovery(browser, false);
  }
  await update(browser, { type: 'updateSettings', patch: { enabled: true } });
  await update(browser, { type: 'toggleSite', hostname: 'youtube.com', allowed: true });
  await checkPage(browser, true);
  await checkRecovery(browser, false);
  await update(browser, { type: 'toggleSite', hostname: 'youtube.com', allowed: false });
  await checkPage(browser, false);
  await checkRecovery(browser, true);
  console.log('PASS: feature pause, master pause, parent-domain exception, and resumed injection after reload');
  await browser.context.close();
  browser = await launch();
  await checkPage(browser, false);
  console.log('PASS: persisted registration after browser restart');
  assert.deepEqual(errors, [], 'page/extension JavaScript errors');
  console.log('Controlled browser smoke passed. Live YouTube ad delivery is not tested.');
} finally {
  await browser?.context.close();
}
