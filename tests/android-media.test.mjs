import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../android/app/src/main/assets/harbortube-media.js', import.meta.url), 'utf8');
const protectionSource = await readFile(new URL('../extension/content/youtube-player.js', import.meta.url), 'utf8');
function setup(payload, responseUrl = 'https://m.youtube.com/youtubei/v1/player', protection = false) {
  const messages = [], events = new Map(), intervals = [];
  let time = 5000, plays = 0, pauses = 0;
  const mountedPlayer = { className: '' };
  class Document {
    get hidden() { return true; }
    get visibilityState() { return 'hidden'; }
    addEventListener(type, callback) { events.set(type, [...(events.get(type) || []), callback]); }
    dispatchEvent(event) { for (const callback of events.get(event.type) || []) callback(event); }
    querySelector(selector) { return selector === '#movie_player' ? mountedPlayer : selector.includes('video') ? video : null; }
  }
  const video = { currentTime: 4, duration: 100, paused: true, ended: false, volume: 1,
    play() { plays++; this.paused = false; return Promise.resolve(); }, pause() { pauses++; this.paused = true; } };
  class XHR { open() {} addEventListener() {} }
  const document = new Document(); document.title = 'Sample - YouTube';
  const location = new URL('https://m.youtube.com/watch?v=abcdefghijk');
  const calls = [];
  class LocalResponse extends Response {}
  const window = { harborTube: { postMessage(value) { messages.push(JSON.parse(value)); } },
    fetch(...args) { calls.push(args); const response = new LocalResponse(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }); Object.defineProperty(response, 'url', { value: responseUrl }); return Promise.resolve(response); } };
  window.location = location;
  const context = vm.createContext({ window, document, Document, XMLHttpRequest: XHR, location, URL, URLSearchParams, Response: LocalResponse,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    performance: { now: () => time }, setInterval: callback => intervals.push(callback) });
  if (protection) { window.__harborGuardYouTubeEnabled = true; vm.runInContext(protectionSource, context); }
  vm.runInContext(source, context);
  return { window, document, video, messages, calls, events,
    tick() { time += 2100; for (const callback of intervals) callback(); },
    setInitial(value) { window.ytInitialPlayerResponse = value; document.dispatchEvent({ type: 'loadedmetadata' }); },
    setMountedPlayer(value) { mountedPlayer.getPlayerResponse = typeof value === 'function' ? value : () => value; document.dispatchEvent({ type: 'loadedmetadata' }); },
    setAd(value) { mountedPlayer.className = value ? 'ad-showing' : ''; },
    navigate(videoId) { location.search = '?v=' + videoId; window.__harborTubeAction('refresh'); },
    counters: () => ({ plays, pauses }) };
}
const player = { videoDetails: { videoId: 'abcdefghijk', title: 'Sample' }, streamingData: { formats: [
  { url: 'https://r1.googlevideo.com/videoplayback?id=media&itag=18', mimeType: 'video/mp4; codecs="avc1, mp4a"', audioQuality: 'AUDIO_QUALITY_MEDIUM', height: 360 }
] } };
test('download observation preserves fetch arguments and the original readable response', async () => {
  const env = setup(player); const request = { custom: true }, init = { signal: {} };
  const response = await env.window.fetch(request, init); await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(env.calls[0][0], request); assert.strictEqual(env.calls[0][1], init);
  assert.deepEqual(await response.json(), player);
  const formats = env.messages.find(item => item.type === 'formats');
  assert.equal(formats.id, 'abcdefghijk'); assert.equal(formats.formats[0].combined, true); assert.equal(formats.formats[0].resolved, true);
});
test('unrelated responses are never observed as downloadable player metadata', async () => {
  const env = setup(player, 'https://elsewhere.example/player'); await env.window.fetch('anything'); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(env.messages.filter(item => item.type === 'formats').length, 0);
});
test('background mode preserves normal visibility and never starts playback by itself', () => {
  const env = setup(player); assert.equal(env.document.hidden, true);
  env.window.__harborTubeAction('background', true); assert.equal(env.document.hidden, false); assert.equal(env.document.visibilityState, 'visible');
  assert.equal(env.counters().plays, 0);
  let stopped = 0; for (const callback of env.events.get('visibilitychange')) callback({ stopImmediatePropagation() { stopped++; } }); assert.equal(stopped, 1);
  env.window.__harborTubeAction('background', false); assert.equal(env.document.hidden, true);
  for (const callback of env.events.get('visibilitychange')) callback({ stopImmediatePropagation() { stopped++; } }); assert.equal(stopped, 1);
  env.window.__harborTubeAction('play'); env.window.__harborTubeAction('pause'); assert.deepEqual(env.counters(), { plays: 1, pauses: 1 });
});
test('polling sends initial format metadata once and does not flood the native bridge', () => {
  const env = setup(player); env.setInitial(player); for (let i = 0; i < 5; i++) env.tick();
  assert.equal(env.messages.filter(item => item.type === 'formats').length, 1);
});
test('ciphered URLs are marked unresolved without transmitting or modifying the cipher', () => {
  const payload = structuredClone(player); const format = payload.streamingData.formats[0];
  delete format.url; format.signatureCipher = 'url=' + encodeURIComponent('https://r1.googlevideo.com/videoplayback?id=x&itag=18') + '&s=encrypted-secret';
  const env = setup(payload); env.setInitial(payload); env.tick();
  const message = env.messages.find(item => item.type === 'formats'); assert.equal(message.formats[0].resolved, false);
  assert.equal(JSON.stringify(message).includes('encrypted-secret'), false); assert.equal(format.signatureCipher.includes('encrypted-secret'), true);
});
test('media observation composes with ad cleaning while keeping video download metadata', async () => {
  const payload = structuredClone(player); payload.adPlacements = [{ placement: 'ad' }]; payload.playerAds = [{}];
  const env = setup(payload, 'https://m.youtube.com/youtubei/v1/player', true);
  const response = await env.window.fetch('https://m.youtube.com/youtubei/v1/player');
  await new Promise(resolve => setTimeout(resolve, 20)); const value = await response.json();
  assert.equal(value.adPlacements, undefined); assert.equal(value.playerAds, undefined);
  assert.deepEqual(value.streamingData, payload.streamingData);
  assert.equal(env.messages.find(item => item.type === 'formats').formats[0].url, payload.streamingData.formats[0].url);
});
test('audio focus ducking restores the chosen volume without increasing it', () => {
  const env = setup(player); env.video.volume = .4;
  env.window.__harborTubeAction('duck'); assert.ok(Math.abs(env.video.volume - .08) < .00001);
  env.window.__harborTubeAction('duck'); assert.ok(Math.abs(env.video.volume - .08) < .00001);
  env.window.__harborTubeAction('restoreVolume'); assert.equal(env.video.volume, .4);
});
test('reads mounted player metadata when mobile YouTube has no initial response global', () => {
  const payload = structuredClone(player);
  payload.streamingData.formats = [];
  payload.streamingData.adaptiveFormats = [
    { url: 'https://rr1.googlevideo.com/videoplayback?source=youtube&id=content&itag=244&n=raw', mimeType: 'video/webm; codecs="vp9"', height: 480, itag: 244 },
    { url: 'https://rr1.googlevideo.com/videoplayback?source=youtube&id=content&itag=251&n=raw', mimeType: 'audio/webm; codecs="opus"', bitrate: 160000, itag: 251 }
  ];
  const env = setup(payload); env.setMountedPlayer(payload); env.tick();
  const formats = env.messages.find(m => m.type === 'formats').formats;
  assert.equal(formats.length, 2); assert.equal(formats[0].itag, 244); assert.equal(formats[0].resolved, false);
});
test('observes the actual transformed playback URL without altering its signature or response', async () => {
  const url = 'https://rr1.googlevideo.com/videoplayback?source=youtube&id=content&itag=244&n=transformed&sig=a%2Bb%2Fc%3D&range=0-1023';
  const env = setup(player, url); const response = await env.window.fetch(url);
  await new Promise(resolve => setTimeout(resolve, 20));
  const stream = env.messages.find(m => m.type === 'stream');
  assert.equal(stream.id, 'abcdefghijk'); assert.equal(stream.url, url);
  assert.deepEqual(await response.json(), player);
});
test('does not offer observed advertisement or unrelated-host streams', async () => {
  const env = setup(player); env.setAd(true);
  await env.window.fetch('https://rr1.googlevideo.com/videoplayback?source=youtube&itag=18');
  env.setAd(false);
  await env.window.fetch('https://rr1.googlevideo.com.evil.example/videoplayback?itag=18');
  assert.equal(env.messages.filter(m => m.type === 'stream').length, 0);
});
test('keeps response metadata until a mobile SPA updates the current video URL', async () => {
  const payload = structuredClone(player); payload.videoDetails.videoId = 'lmnopqrstuv';
  const env = setup(payload); await env.window.fetch('https://m.youtube.com/youtubei/v1/player');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(env.messages.filter(m => m.type === 'formats').length, 0);
  env.navigate('lmnopqrstuv'); env.tick();
  assert.equal(env.messages.filter(m => m.type === 'formats').length, 1);
  assert.equal(env.messages.find(m => m.type === 'formats').id, 'lmnopqrstuv');
  env.navigate('abcdefghijk'); env.tick();
  assert.equal(env.messages.filter(m => m.type === 'formats' && m.id === 'abcdefghijk').length, 0);
});
test('normal video playback does not poll player metadata or send repeating native progress', () => {
  const env = setup(player); let reads = 0;
  // The player may create a fresh object on every getPlayerResponse call.
  // Reading it on each clock tick would repeatedly parse and send 40 URLs.
  env.setMountedPlayer(() => { reads++; return structuredClone(player); });
  const before = env.messages.length;
  for (let i = 0; i < 60; i++) { env.video.currentTime++; env.tick(); }
  assert.equal(env.messages.length, before); assert.equal(reads, 1);
});
test('native timeline updates run only while player controls or background audio need them', () => {
  const env = setup(player); env.window.__harborTubeAction('details', true);
  const initial = env.messages.filter(m => m.type === 'state').length;
  env.video.currentTime = 10; env.tick();
  assert.equal(env.messages.filter(m => m.type === 'state').length, initial + 1);
  env.window.__harborTubeAction('details', false); const closed = env.messages.length;
  env.video.currentTime = 15; env.tick(); assert.equal(env.messages.length, closed);
  env.window.__harborTubeAction('background', true); const background = env.messages.length;
  env.video.currentTime = 20; env.tick(); assert.ok(env.messages.length > background);
});
test('repeated byte ranges do not flood the bridge or rewrite the signed playback URL', async () => {
  const original = 'https://rr1.googlevideo.com/videoplayback?source=youtube&id=content&itag=244&n=transformed&sig=a%2Bb%2Fc%3D';
  const env = setup(player, 'https://elsewhere.example/unused');
  for (let i = 0; i < 12; i++) await env.window.fetch(original + '&range=' + i * 1024 + '-' + (i + 1) * 1024 + '&rn=' + i);
  const messages = env.messages.filter(m => m.type === 'stream');
  assert.equal(messages.length, 1); assert.equal(messages[0].url, original + '&range=0-1024&rn=0');
});
