import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/content/youtube-player.js', import.meta.url), 'utf8');
const bootstrap = fs.readFileSync(new URL('../extension/content/youtube-bootstrap.js', import.meta.url), 'utf8');
const endpoint = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const payload = () => ({
  adPlacements: [{ adPlacementRenderer: { id: 'placement' } }],
  playerAds: [{ id: 'player-ad' }],
  adSlots: [{ id: 'slot' }],
  playabilityStatus: { status: 'OK' },
  streamingData: { adaptiveFormats: [{ mimeType: 'audio/webm', url: 'https://media.example/audio' }] },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } },
  videoDetails: { videoId: 'main-video', lengthSeconds: '300' },
  nested: { adPlacements: ['keep unrelated nested data'] },
});
const cleaned = () => {
  const value = payload();
  delete value.adPlacements;
  delete value.playerAds;
  delete value.adSlots;
  return value;
};
const jsonResponse = (body = payload(), init = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Keep': 'original' },
  ...init,
});

function launch({ fetchImpl = async () => jsonResponse(), initial, registered = false, href = 'https://www.youtube.com/watch?v=main-video' } = {}) {
  const listeners = new Map();
  const events = [];
  class PageEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const document = {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    dispatchEvent(event) {
      events.push(event.type);
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
  };
  const window = { location: new URL(href), fetch: fetchImpl, ytInitialPlayerResponse: initial };
  const context = vm.createContext({ window, document, URL, Request, CustomEvent: PageEvent });
  if (registered) vm.runInContext(bootstrap, context);
  vm.runInContext(source, context, { filename: 'youtube-player.js' });
  return {
    window,
    events,
    configure: (enabled) => document.dispatchEvent(new PageEvent('harbor-guard:youtube-config', { detail: { enabled } })),
    emit: (type) => document.dispatchEvent(new PageEvent(type)),
    evaluate: (code) => vm.runInContext(code, context),
  };
}

test('defaults off, signals readiness, forwards the original Request and init unchanged', async () => {
  let received;
  const response = jsonResponse();
  const page = launch({ fetchImpl: function (...args) { received = { thisValue: this, args }; return Promise.resolve(response); } });
  assert.deepEqual(page.events, ['harbor-guard:youtube-ready']);
  const request = new Request(endpoint, { method: 'POST', body: '{"videoId":"main-video"}' });
  const init = { credentials: 'include', signal: new AbortController().signal };
  const result = await page.window.fetch(request, init);
  assert.equal(received.thisValue, page.window);
  assert.equal(received.args[0], request);
  assert.equal(received.args[1], init);
  assert.equal(request.bodyUsed, false);
  assert.equal(result, response, 'the original Response object and metadata survive');
  assert.deepEqual(await result.json(), payload());
});

test('persisted bootstrap cleans assignments before inline player consumption or storage resolution', async () => {
  const page = launch({ registered: true });
  page.window.ytInitialPlayerResponse = payload();
  assert.deepEqual(page.window.ytInitialPlayerResponse, cleaned());
  page.window.playerResponse = payload();
  assert.deepEqual(page.window.playerResponse, cleaned());
  assert.equal('__harborGuardYouTubeEnabled' in page.window, false);
  assert.deepEqual(await (await page.window.fetch(endpoint)).json(), cleaned());
  page.configure(false);
  page.window.ytInitialPlayerResponse = payload();
  assert.deepEqual(page.window.ytInitialPlayerResponse, payload());
});

test('initial player ad fields stay undefined after later reinsertion and accept ordinary assignments when paused', () => {
  const page = launch({ registered: true, initial: payload() });
  for (const field of ['adPlacements', 'playerAds', 'adSlots']) {
    page.window.ytInitialPlayerResponse[field] = ['reinserted ad'];
    assert.equal(page.window.ytInitialPlayerResponse[field], undefined);
  }
  page.emit('yt-page-data-updated');
  page.window.ytInitialPlayerResponse.adPlacements = ['reinserted again'];
  assert.equal(page.window.ytInitialPlayerResponse.adPlacements, undefined);
  page.configure(false);
  page.window.ytInitialPlayerResponse.adPlacements = ['allowed while paused'];
  assert.deepEqual(page.window.ytInitialPlayerResponse.adPlacements, ['allowed while paused']);
  assert.ok(JSON.stringify(page.window.ytInitialPlayerResponse).includes('allowed while paused'));
});

test('known player envelopes are cleaned across player, playlist, and get_watch without walking unrelated trees', async () => {
  for (const path of ['player', 'playlist', 'get_watch']) {
    const value = [{ playerResponse: payload(), unrelated: { adSlots: ['keep'] } }];
    const page = launch({ registered: true, fetchImpl: async () => jsonResponse(value) });
    const actual = await (await page.window.fetch(`/youtubei/v1/${path}?key=test`)).json();
    assert.deepEqual(actual, [{ playerResponse: cleaned(), unrelated: { adSlots: ['keep'] } }]);
  }
});

test('resolve_url prefetches are cleaned before playback while navigation and unrelated ads survive', async () => {
  const envelope = (player) => ({
    endpoint: { watchEndpoint: { videoId: 'main-video', unserializedPrefetchData: { playerResponse: player, nextResponse: { adSlots: ['keep'] } } } },
    adSlots: ['navigation metadata'],
  });
  const page = launch({ registered: true, fetchImpl: async () => jsonResponse(envelope(payload())) });
  const result = await page.window.fetch('/youtubei/v1/navigation/resolve_url?prettyPrint=false');
  assert.deepEqual(await result.clone().json(), envelope(cleaned()));
  assert.deepEqual(JSON.parse(await result.text()), envelope(cleaned()));
  assert.deepEqual(await (await page.window.fetch('/youtubei/v1/next')).json(), envelope(payload()));
  page.configure(false);
  assert.deepEqual(await (await page.window.fetch('/youtubei/v1/navigation/resolve_url')).json(), envelope(payload()));
});

test('legacy watch JSON keeps the anti-XSSI guard while removing nested player advertisements', async () => {
  const body = ")]}'\n" + JSON.stringify([{ playerResponse: payload() }]);
  const page = launch({ registered: true, fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }) });
  const result = await (await page.window.fetch('/watch?v=main-video&pbj=1')).text();
  assert.ok(result.startsWith(")]}'\n"));
  assert.deepEqual(JSON.parse(result.slice(5)), [{ playerResponse: cleaned() }]);
});

test('serialized initial player JSON is cleaned only when recognizable and keeps parse/reviver semantics', () => {
  const page = launch({ registered: true });
  const parseInPage = (value) => JSON.parse(JSON.stringify(page.evaluate(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`)));
  assert.deepEqual(parseInPage(payload()), cleaned());
  assert.deepEqual(parseInPage({ adSlots: ['unrelated settings'] }), { adSlots: ['unrelated settings'] });
  assert.equal(page.evaluate('JSON.parse("42", (key, value) => typeof value === "number" ? value + 1 : value)'), 43);
  assert.throws(() => page.evaluate('JSON.parse("{invalid")'), { name: 'SyntaxError' });
  page.configure(false);
  assert.deepEqual(parseInPage(payload()), payload());
});

test('enabled player JSON removes only the three known top-level ad fields', async () => {
  const page = launch();
  page.configure(true);
  assert.deepEqual(await (await page.window.fetch(endpoint)).json(), cleaned());
  const text = await (await page.window.fetch(new URL(endpoint))).text();
  assert.deepEqual(JSON.parse(text), cleaned());
});

test('matches only HTTPS player endpoints on the supported YouTube hosts', async () => {
  const page = launch();
  page.configure(true);
  for (const target of [
    '/youtubei/v1/player?key=test',
    'https://m.youtube.com/youtubei/v1/player',
    'https://youtube.com/youtubei/v1/player',
    '/watch?v=main-video&pbj=1',
    '/playlist?list=fixture&pbj=1',
  ]) assert.deepEqual(await (await page.window.fetch(target)).json(), cleaned());
  for (const target of [
    'https://other.example/youtubei/v1/player',
    'https://www.youtube.com.evil.example/youtubei/v1/player',
    'https://www.youtube.com/youtubei/v1/next',
    'https://www.youtube.com/youtubei/v1/player/extra',
    'https://www.youtube.com/watch',
    'https://ads.youtube.com/youtubei/v1/player',
    'https://www.youtube.com:8443/youtubei/v1/player',
    'http://www.youtube.com/youtubei/v1/player',
  ]) assert.deepEqual(await (await page.window.fetch(target)).json(), payload(), target);
  const elsewhere = launch({ href: 'https://other.example/' });
  elsewhere.configure(true);
  assert.deepEqual(await (await elsewhere.window.fetch(endpoint)).json(), payload());
});

test('disabled and in-flight response consumption uses the latest configuration', async () => {
  let resolveFetch;
  const page = launch({ fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
  page.configure(true);
  const pending = page.window.fetch(endpoint);
  page.configure(false);
  resolveFetch(jsonResponse());
  assert.deepEqual(await (await pending).json(), payload());

  const second = launch();
  second.configure(true);
  const response = await second.window.fetch(endpoint);
  const consuming = response.json();
  second.configure(false);
  assert.deepEqual(await consuming, payload());

  second.configure(true);
  const textResponse = await second.window.fetch(endpoint);
  second.configure(false);
  assert.deepEqual(JSON.parse(await textResponse.text()), payload());
});

test('non-JSON, unsuccessful, redirected-away, and malformed responses remain unchanged', async () => {
  for (const response of [
    new Response(JSON.stringify(payload()), { headers: { 'Content-Type': 'text/plain' } }),
    jsonResponse(payload(), { status: 403 }),
    jsonResponse(payload(), { status: 500 }),
  ]) {
    const page = launch({ fetchImpl: async () => response });
    page.configure(true);
    assert.equal(await page.window.fetch(endpoint), response);
    assert.deepEqual(await response.json(), payload());
  }
  const redirected = jsonResponse();
  Object.defineProperty(redirected, 'url', { value: 'https://other.example/youtubei/v1/player' });
  const redirectPage = launch({ fetchImpl: async () => redirected });
  redirectPage.configure(true);
  assert.deepEqual(await (await redirectPage.window.fetch(endpoint)).json(), payload());

  const bad = launch({ fetchImpl: async () => new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }) });
  bad.configure(true);
  assert.equal(await (await bad.window.fetch(endpoint)).text(), '{invalid');
  await assert.rejects((await bad.window.fetch(endpoint)).json(), SyntaxError);
});

test('network rejection identity and request abort signals pass through unchanged', async () => {
  const failure = new TypeError('Network unavailable');
  let received;
  const page = launch({ fetchImpl: (input, init) => { received = init; return Promise.reject(failure); } });
  page.configure(true);
  const signal = AbortSignal.abort();
  await assert.rejects(page.window.fetch(endpoint, { signal }), (error) => error === failure);
  assert.equal(received.signal, signal);
});

test('clone keeps native Response status, headers, body semantics, and independent consumption', async () => {
  const original = jsonResponse(payload(), { status: 202, statusText: 'Accepted' });
  const page = launch({ fetchImpl: async () => original });
  page.configure(true);
  const response = await page.window.fetch(endpoint);
  const clone = response.clone();
  assert.ok(response instanceof Response);
  assert.ok(clone instanceof Response);
  for (const key of ['status', 'statusText', 'url', 'type', 'redirected', 'ok']) assert.equal(clone[key], original[key], key);
  assert.equal(clone.headers.get('x-keep'), 'original');
  assert.equal(response.bodyUsed, false);
  assert.equal(clone.bodyUsed, false);
  assert.deepEqual(await clone.json(), cleaned());
  assert.equal(clone.bodyUsed, true);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), cleaned());
  assert.equal(response.bodyUsed, true);
  await assert.rejects(response.json(), TypeError);
  assert.throws(() => response.clone(), TypeError);
});

test('borrowed Response methods do not sanitize an unrelated response', async () => {
  const page = launch();
  page.configure(true);
  const response = await page.window.fetch(endpoint);
  assert.deepEqual(await response.json.call(jsonResponse()), payload());
  assert.deepEqual(JSON.parse(await response.text.call(jsonResponse())), payload());
  assert.deepEqual(await response.clone.call(jsonResponse()).json(), payload());
});

test('initial player cleanup waits for configuration and preserves unrelated data on navigation', () => {
  const initial = payload();
  const page = launch({ initial });
  page.emit('DOMContentLoaded');
  assert.deepEqual(initial, payload());
  page.configure(true);
  assert.equal(page.window.ytInitialPlayerResponse, initial);
  assert.deepEqual(initial, cleaned());

  for (const name of ['DOMContentLoaded', 'yt-navigate-finish', 'yt-page-data-updated']) {
    page.window.ytInitialPlayerResponse = payload();
    page.emit(name);
    assert.deepEqual(page.window.ytInitialPlayerResponse, cleaned());
  }
  page.configure(false);
  page.window.ytInitialPlayerResponse = payload();
  page.emit('yt-navigate-finish');
  assert.deepEqual(page.window.ytInitialPlayerResponse, payload());
  page.configure('true');
  page.emit('yt-page-data-updated');
  assert.deepEqual(page.window.ytInitialPlayerResponse, payload());
});

test('frozen initial objects, non-object JSON, and already-clean text remain usable', async () => {
  const frozen = Object.freeze(payload());
  const page = launch({ initial: frozen });
  assert.doesNotThrow(() => page.configure(true));
  assert.deepEqual(frozen, payload());
  for (const body of ['null', '[]', '42', '{ "videoDetails": { "videoId": "main-video" } }']) {
    const special = launch({ fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }) });
    special.configure(true);
    assert.equal(await (await special.window.fetch(endpoint)).text(), body);
  }
});

test('configuration toggles never replace later fetch wrappers or install duplicates', async () => {
  const page = launch();
  const installed = page.window.fetch;
  const later = (...args) => installed(...args);
  page.window.fetch = later;
  page.configure(true);
  page.configure(false);
  page.configure(true);
  assert.equal(page.window.fetch, later);
  assert.deepEqual(await (await page.window.fetch(endpoint)).json(), cleaned());
});
