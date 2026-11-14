import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/content/youtube-recovery.js', import.meta.url), 'utf8');
const id = 'abcdefghijk';
const nextId = 'lmnopqrstuv';
const help = 'https://support.google.com/youtube/answer/3037019';
const blocked = (interstitial = false) => ({
  videoDetails: { videoId: id },
  playabilityStatus: { status: 'UNPLAYABLE', errorScreen: interstitial
    ? { playerInterstitialRenderer: { content: { interstitialViewModel: { description: { commandRuns: [{ onTap: { innertubeCommand: { commandMetadata: { webCommandMetadata: { url: help } } } } }] } } } } }
    : { playerErrorMessageRenderer: { subreason: { runs: [{ navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: help, webPageType: 'WEB_PAGE_TYPE_UNKNOWN' } } } }] } } } },
});
const body = () => ({
  videoId: id,
  context: { client: { clientName: 'WEB', clientScreen: 'WATCH', clientVersion: 'keep', userAgent: 'keep-agent', visitorData: 'keep-visitor' }, user: { lockedSafetyMode: true } },
  playbackContext: { contentPlaybackContext: { signatureTimestamp: 12345, referer: 'https://www.youtube.com/' } },
  attestationRequest: { omitBotguardData: false },
  playlistId: 'PL-keep', params: 'keep-params', contentCheckOk: false,
});

function launch({ response = blocked(), enabled = true, href = `https://www.youtube.com/watch?v=${id}&t=1m30s`, fetchImpl, protectedApis = false } = {}) {
  const listeners = new Map();
  const events = [];
  const calls = [];
  const reloads = [];
  const xhrBodies = [];
  const timers = new Map();
  let clock = 0;
  let timerId = 0;
  const location = new URL(href);
  const video = {};
  const player = {
    className: '', response, state: 1, time: 75, debug: '',
    getPlayerResponse() { return this.response; },
    getPlayerState() { return this.state; },
    getCurrentTime() { return this.time; },
    getStatsForNerds() { return { debug_info: this.debug }; },
    querySelector: () => video,
    loadVideoById: (...args) => reloads.push({ method: 'load', args }),
    cueVideoById: (...args) => reloads.push({ method: 'cue', args }),
  };
  const playlistRestores = [];
  const manager = {
    getPlaylistData: () => ({ playlistId: 'PL-keep', contents: ['keep'] }),
    setPlaylistData: (value) => playlistRestores.push(value),
    setPlayerPlaybackControlData: (value) => playlistRestores.push(value),
  };
  class PageEvent {
    constructor(type, options = {}) { Object.assign(this, options); this.type = type; }
  }
  const document = {
    documentElement: {},
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
    dispatchEvent(event) { events.push(event); for (const callback of listeners.get(event.type) || []) callback(event); },
    querySelector: (selector) => selector === '#movie_player' ? player : selector === 'yt-playlist-manager' ? manager : null,
  };
  class XHR {
    open(method, url) { this.method = method; this.url = url; }
    send(value) { xhrBodies.push(value); }
  }
  const nativeFetch = fetchImpl || function (...args) { calls.push({ receiver: this, args }); return Promise.resolve('native-response'); };
  const context = vm.createContext({
    document, location, URL, Request, CustomEvent: PageEvent, XMLHttpRequest: XHR, fetch: nativeFetch,
    __harborGuardYouTubeEnabled: enabled,
    performance: { now: () => clock },
    setTimeout(fn, delay) { const key = ++timerId; timers.set(key, { fn, at: clock + delay }); return key; },
    clearTimeout: (key) => timers.delete(key),
    MutationObserver: class { observe() {} disconnect() {} },
  });
  vm.runInContext('window = globalThis', context);
  if (protectedApis) vm.runInContext('Object.defineProperty(window, "fetch", { writable: false }); Object.defineProperty(XMLHttpRequest.prototype, "send", { writable: false });', context);
  vm.runInContext(source, context);
  const emit = (type, options) => document.dispatchEvent(new PageEvent(type, options));
  return {
    player, video, calls, reloads, xhrBodies, events, timers, location, playlistRestores,
    fetch: (...args) => context.fetch(...args),
    xhr: () => new XHR(), emit,
    status: () => events.filter((event) => event.type === 'harbor-guard:youtube-recovery-ready').at(-1)?.detail,
    configure: (value) => emit('harbor-guard:youtube-config', { detail: { enabled: value } }),
    advance(ms) {
      const end = clock + ms;
      for (let count = 0; count < 100; count++) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) { clock = end; return; }
        const [key, timer] = due;
        timers.delete(key); clock = timer.at; timer.fn();
      }
      throw new Error('Unexpected retry loop');
    },
  };
}

test('both known ad-block error renderers retry the native player at the requested timestamp', async () => {
  for (const interstitial of [false, true]) {
    const response = blocked(interstitial);
    const page = launch({ response });
    page.emit('DOMContentLoaded');
    assert.deepEqual(page.reloads, [{ method: 'load', args: [id, 90] }]);
    assert.equal(page.player.response, response, 'the real error response is retained until native playback succeeds');
    assert.equal(page.status().phase, 'retrying');
    const raw = JSON.stringify(body());
    const init = { method: 'POST', body: raw, headers: { 'x-keep': 'original' }, credentials: 'include', signal: new AbortController().signal };
    assert.equal(await page.fetch('/youtubei/v1/player', init), 'native-response');
    const actual = page.calls.at(-1).args[1];
    const expected = body(); expected.context.client.clientScreen = 'CHANNEL';
    assert.deepEqual(JSON.parse(actual.body), expected);
    assert.equal(actual.headers, init.headers); assert.equal(actual.signal, init.signal); assert.equal(actual.credentials, 'include');
    assert.equal(init.body, raw, 'the caller-owned request is never mutated');
  }
});

test('normal playback, unrelated failures, captcha and stale video responses never trigger recovery', () => {
  const captcha = blocked(); captcha.playabilityStatus.errorScreen.playerErrorMessageRenderer.playerCaptchaViewModel = {};
  const unrelated = blocked(); unrelated.playabilityStatus.errorScreen.playerErrorMessageRenderer.subreason.runs[0].navigationEndpoint.commandMetadata.webCommandMetadata.url = help.replace('support.google.com', 'support.google.com.evil.example');
  const stale = blocked(); stale.videoDetails.videoId = nextId;
  for (const response of [
    { playabilityStatus: { status: 'OK' } }, { playabilityStatus: { status: 'LOGIN_REQUIRED' } },
    { playabilityStatus: { status: 'UNPLAYABLE', reason: 'not available in your country' } },
    { playabilityStatus: { ...blocked().playabilityStatus, status: 'ERROR' } }, captcha, unrelated, stale,
  ]) {
    const page = launch({ response }); page.emit('DOMContentLoaded'); page.advance(20000);
    assert.deepEqual(page.reloads, []);
  }
  for (const href of ['http://www.youtube.com/watch?v=' + id, 'https://www.youtube.com:8443/watch?v=' + id, 'https://example.com/watch?v=' + id, 'https://www.youtube.com/shorts/' + id, 'https://www.youtube.com/embed/' + id]) {
    const page = launch({ href }); page.emit('DOMContentLoaded'); page.advance(20000);
    assert.deepEqual(page.reloads, [], href);
  }
});

test('recovery makes at most two spaced attempts and same-video navigation or toggle cycles cannot refill its budget', async () => {
  const page = launch(); page.emit('DOMContentLoaded');
  for (let i = 0; i < 10; i++) page.emit('yt-page-data-updated');
  page.advance(3999); assert.equal(page.reloads.length, 1);
  page.advance(1); assert.equal(page.reloads.length, 2);
  await page.fetch('/youtubei/v1/player', { method: 'POST', body: JSON.stringify(body()) });
  const expected = body(); expected.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd = true;
  assert.deepEqual(JSON.parse(page.calls.at(-1).args[1].body), expected);
  page.advance(20000); assert.equal(page.reloads.length, 2); assert.equal(page.status().phase, 'exhausted');
  page.location.searchParams.set('t', '5'); page.emit('yt-navigate-finish');
  page.configure(false); page.configure(true); page.advance(20000);
  assert.equal(page.reloads.length, 2);
});

test('pause cancels pending recovery and requests immediately, including an in-flight Request clone read', async () => {
  const page = launch(); page.emit('DOMContentLoaded');
  const raw = JSON.stringify(body());
  const request = new Request('https://www.youtube.com/youtubei/v1/player', { method: 'POST', body: raw, headers: { 'content-type': 'application/json' } });
  const pending = page.fetch(request);
  page.configure(false);
  assert.equal(await pending, 'native-response');
  assert.deepEqual(page.calls.at(-1).args, [request]);
  page.advance(20000); assert.equal(page.reloads.length, 1); assert.equal(page.timers.size, 0);
  const init = { method: 'POST', body: raw };
  await page.fetch('/youtubei/v1/player', init);
  assert.equal(page.calls.at(-1).args[1], init);
  const disabled = launch({ enabled: false }); disabled.emit('DOMContentLoaded'); disabled.configure('true'); disabled.advance(20000);
  assert.deepEqual(disabled.reloads, []);
});

test('only the current WEB video on the POST player endpoint changes during recovery', async () => {
  const page = launch(); page.emit('DOMContentLoaded');
  for (const [url, method, value] of [
    ['/youtubei/v1/next', 'POST', body()], ['https://example.com/youtubei/v1/player', 'POST', body()],
    ['/youtubei/v1/player', 'GET', body()], ['/youtubei/v1/player', 'POST', { ...body(), videoId: nextId }],
    ['/youtubei/v1/player', 'POST', { ...body(), context: { client: { clientName: 'ANDROID' } } }],
  ]) {
    const init = { method, body: JSON.stringify(value) }; await page.fetch(url, init);
    assert.equal(page.calls.at(-1).args[1], init);
  }
  const malformed = { method: 'POST', body: '{broken' }; await page.fetch('/youtubei/v1/player', malformed);
  assert.equal(page.calls.at(-1).args[1], malformed);
  const request = new Request('https://www.youtube.com/youtubei/v1/player', { method: 'POST', body: JSON.stringify(body()), headers: { 'content-type': 'application/json' } });
  await page.fetch(request);
  assert.equal(page.calls.at(-1).args[0], request);
  assert.equal(JSON.parse(page.calls.at(-1).args[1].body).context.client.clientScreen, 'CHANNEL');
});

test('XHR recovery respects endpoint, method, reuse and the current pause setting', () => {
  const page = launch(); page.emit('DOMContentLoaded');
  const xhr = page.xhr(); const raw = JSON.stringify(body());
  xhr.open('POST', '/youtubei/v1/player'); xhr.send(raw);
  assert.equal(JSON.parse(page.xhrBodies.at(-1)).context.client.clientScreen, 'CHANNEL');
  xhr.open('POST', '/youtubei/v1/next'); xhr.send(raw); assert.equal(page.xhrBodies.at(-1), raw);
  xhr.open('GET', '/youtubei/v1/player'); xhr.send(raw); assert.equal(page.xhrBodies.at(-1), raw);
  xhr.open('POST', '/youtubei/v1/player'); page.configure(false); xhr.send(raw); assert.equal(page.xhrBodies.at(-1), raw);
});

test('normal video position and explicit pause survive recovery; ads do not replace the saved position', () => {
  const page = launch({ response: { videoDetails: { videoId: id }, playabilityStatus: { status: 'OK' } } });
  page.emit('playing', { target: page.video });
  page.emit('pause', { target: page.video });
  page.player.className = 'ad-showing'; page.player.time = 3; page.emit('timeupdate', { target: page.video });
  page.player.response = blocked(); page.emit('yt-page-data-updated');
  assert.deepEqual(page.reloads, [{ method: 'cue', args: [id, 75] }]);
});

test('successful playback cancels the retry timer and restores the native playlist if the reload detached it', () => {
  const page = launch({ href: `https://www.youtube.com/watch?v=${id}&list=PL-keep` }); page.emit('DOMContentLoaded');
  page.player.getPlaylistId = () => null;
  page.player.response = { videoDetails: { videoId: id }, playabilityStatus: { status: 'OK' } };
  page.emit('playing', { target: page.video }); page.advance(20000);
  assert.equal(page.reloads.length, 1); assert.equal(page.status().phase, 'idle');
  assert.equal(page.playlistRestores.length, 2);
  assert.equal(page.playlistRestores[0].playlistId, 'PL-keep');
});

test('a response marked OK before media starts cannot overwrite the requested resume position', () => {
  const page = launch(); page.emit('DOMContentLoaded');
  page.player.response = { videoDetails: { videoId: id }, playabilityStatus: { status: 'OK' } };
  page.player.time = 0; page.emit('yt-page-data-updated');
  page.player.response = blocked(); page.emit('yt-page-data-updated'); page.advance(4000);
  assert.deepEqual(page.reloads.map((entry) => entry.args), [[id, 90], [id, 90]]);
});

test('a failing native reload still finishes its bounded recovery without remaining stuck in retrying', () => {
  const page = launch(); let attempts = 0;
  page.player.loadVideoById = () => { attempts++; throw new Error('player unavailable'); };
  page.emit('DOMContentLoaded'); page.advance(20000);
  assert.equal(attempts, 2); assert.equal(page.status().phase, 'exhausted'); assert.equal(page.timers.size, 0);
});

test('navigation to a different video cancels old retries and starts with an unmodified request', async () => {
  const page = launch(); page.emit('DOMContentLoaded');
  page.location.searchParams.set('v', nextId);
  const init = { method: 'POST', body: JSON.stringify({ ...body(), videoId: nextId }) };
  await page.fetch('/youtubei/v1/player', init); assert.equal(page.calls.at(-1).args[1], init);
  page.emit('yt-navigate-finish'); page.advance(20000); assert.equal(page.reloads.length, 1);
  page.player.response = { ...blocked(), videoDetails: { videoId: nextId } }; page.emit('yt-page-data-updated');
  assert.equal(page.reloads.length, 2); assert.equal(page.reloads.at(-1).args[0], nextId);
});

test('native fetch synchronous errors and rejections are forwarded once without a second request', async () => {
  for (const synchronous of [true, false]) {
    let calls = 0;
    const failure = new Error('native failure');
    const page = launch({ fetchImpl: () => { calls++; if (synchronous) throw failure; return Promise.reject(failure); } });
    page.emit('DOMContentLoaded');
    const invoke = () => page.fetch('/youtubei/v1/player', { method: 'POST', body: JSON.stringify(body()) });
    if (synchronous) assert.throws(invoke, (error) => error === failure);
    else await assert.rejects(invoke(), (error) => error === failure);
    assert.equal(calls, 1);
  }
});

test('unavailable protected request APIs report missing recovery and never reload playback', () => {
  const page = launch({ protectedApis: true }); page.emit('DOMContentLoaded');
  assert.equal(page.status().installed, false); assert.deepEqual(page.reloads, []);
});
