import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../extension/content/youtube-player.js', import.meta.url), 'utf8');
const bootstrapSource = fs.readFileSync(new URL('../extension/content/youtube-bootstrap.js', import.meta.url), 'utf8');
const compatSource = fs.readFileSync(new URL('../extension/content/youtube-compat.js', import.meta.url), 'utf8');
const recoverySource = fs.readFileSync(new URL('../extension/content/youtube-recovery.js', import.meta.url), 'utf8');
const isolatedSource = fs.readFileSync(new URL('../extension/content/protect.js', import.meta.url), 'utf8');
const playerData = () => ({ adPlacements: [{ id: 'ad' }], streamingData: { formats: [{ itag: 18 }] } });

// Run both complete scripts in separate JS worlds sharing only DOM events.
// No real browser, YouTube request, or extension setting is touched here.
function fixture({ registered = false } = {}) {
  const listeners = new Map();
  const storageListeners = [];
  const storageWrites = [];
  const messages = [];
  const observers = [];
  const timers = new Map();
  let timerId = 0;
  let resolveStorage;
  let rejectStorage;
  const stored = new Promise((resolve, reject) => { resolveStorage = resolve; rejectStorage = reject; });
  const location = new URL('https://www.youtube.com/watch?v=main-video');
  class SharedEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const document = {
    documentElement: null,
    head: null,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
  };
  class Observer {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe(target) { this.target = target; this.active = true; }
    disconnect() { this.active = false; }
  }
  const mainWindow = {
    location,
    ytInitialPlayerResponse: playerData(),
    fetch: async () => new Response(JSON.stringify(playerData()), { headers: { 'Content-Type': 'application/json' } }),
  };
  const mainWorld = vm.createContext({ window: mainWindow, document, URL, Request, CustomEvent: SharedEvent,
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext('window.Promise = Promise;', mainWorld);
  const isolatedWorld = vm.createContext({
    document,
    window: { addEventListener() {} },
    location,
    CustomEvent: SharedEvent,
    MutationObserver: Observer,
    performance: { now: () => 0 },
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    chrome: {
      runtime: { id: 'a'.repeat(32), sendMessage: async (message) => { messages.push(message); } },
      storage: {
        local: { get: () => stored, set: async (value) => { storageWrites.push(value); } },
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
      },
    },
  });
  const config = (enabled) => document.dispatchEvent(new SharedEvent('harbor-guard:youtube-config', { detail: { enabled } }));
  return {
    document, mainWindow, storageWrites, messages, timers, config,
    loadMain: () => {
      if (registered) vm.runInContext(bootstrapSource, mainWorld, { filename: 'youtube-bootstrap.js' });
      vm.runInContext(compatSource, mainWorld, { filename: 'youtube-compat.js' });
      vm.runInContext(recoverySource, mainWorld, { filename: 'youtube-recovery.js' });
      vm.runInContext(mainSource, mainWorld, { filename: 'youtube-player.js' });
    },
    loadIsolated: () => vm.runInContext(isolatedSource, isolatedWorld, { filename: 'protect.js' }),
    resolveSettings: async (settings) => { resolveStorage({ settings }); await Promise.resolve(); },
    rejectSettings: async () => { rejectStorage(new Error('Storage unavailable')); await Promise.resolve(); },
    changeSettings: (settings) => {
      for (const fn of storageListeners) fn({ settings: { newValue: settings } }, 'local');
    },
    fetchPlayer: async () => (await mainWindow.fetch('/youtubei/v1/player')).json(),
    warningProbe: () => vm.runInContext('Promise.resolve().then(() => { const detector = { onAbnormalityDetected: () => true }; return detector.onAbnormalityDetected(); })', mainWorld),
    emit: (name) => document.dispatchEvent(new SharedEvent(name)),
  };
}

for (const order of ['main-first', 'isolated-first']) {
  for (const { name, settings, expected } of [
    { name: 'global pause', settings: { enabled: false }, expected: false },
    { name: 'YouTube-only pause', settings: { youtube: false }, expected: false },
    { name: 'parent site exception', settings: { siteAllowlist: ['youtube.com'] }, expected: false },
    { name: 'enabled protection', settings: {}, expected: true },
  ]) {
    test(`world bridge ${order} applies saved ${name} before a DOM root exists`, async () => {
      const page = fixture();
      if (order === 'main-first') {
        page.loadMain();
        page.loadIsolated();
        assert.ok((await page.fetchPlayer()).adPlacements, 'unloaded preferences keep MAIN helper off');
        await page.resolveSettings(settings);
      } else {
        page.loadIsolated();
        await page.resolveSettings(settings);
        page.loadMain(); // Its ready event must recover an earlier missed config event.
      }
      assert.equal(page.document.documentElement, null);
      const result = await page.fetchPlayer();
      assert.equal('adPlacements' in result, !expected);
      assert.equal(await page.warningProbe(), expected ? undefined : true, 'the warning guard receives the same saved setting as the player helper');
      assert.equal(page.mainWindow.ytInitialPlayerResponse.adPlacements !== undefined, !expected);
      assert.deepEqual(result.streamingData, { formats: [{ itag: 18 }] });
      assert.equal(page.timers.size, 0, 'no DOM scan runs before a root exists');
      assert.deepEqual(page.storageWrites, []);
      assert.deepEqual(page.messages, []);
    });
  }
}

test('bridge pause and site exceptions disable already-fetched responses before consumption', async () => {
  const page = fixture();
  page.loadMain();
  page.loadIsolated();
  await page.resolveSettings({});
  const response = await page.mainWindow.fetch('/youtubei/v1/player');
  page.changeSettings({ enabled: false });
  assert.ok((await response.json()).adPlacements);
  assert.ok((await page.fetchPlayer()).adPlacements);
  assert.equal(await page.warningProbe(), true);
  page.changeSettings({ siteAllowlist: ['youtube.com'] });
  assert.ok((await page.fetchPlayer()).adPlacements);
  assert.equal(await page.warningProbe(), true);
  page.changeSettings({});
  assert.equal('adPlacements' in await page.fetchPlayer(), false);
  assert.equal(await page.warningProbe(), undefined);
});

test('stale storage startup cannot undo a newer pause delivered over the bridge', async () => {
  const page = fixture();
  page.loadMain();
  page.loadIsolated();
  page.changeSettings({ enabled: false });
  await page.resolveSettings({ enabled: true });
  assert.ok((await page.fetchPlayer()).adPlacements);
  assert.ok(page.mainWindow.ytInitialPlayerResponse.adPlacements);
});

test('failed preference loading leaves the MAIN helper disabled in either load order', async () => {
  for (const order of ['main-first', 'isolated-first']) {
    const page = fixture();
    if (order === 'main-first') page.loadMain();
    page.loadIsolated();
    await page.rejectSettings();
    if (order === 'isolated-first') page.loadMain();
    assert.ok((await page.fetchPlayer()).adPlacements);
    assert.ok(page.mainWindow.ytInitialPlayerResponse.adPlacements);
    assert.equal(await page.warningProbe(), true);
  }
});

test('failed preference loading disables a persisted early helper for subsequent player data', async () => {
  const page = fixture({ registered: true });
  page.loadMain();
  assert.equal('adPlacements' in await page.fetchPlayer(), false);
  assert.equal(await page.warningProbe(), undefined);
  page.loadIsolated();
  await page.rejectSettings();
  assert.ok((await page.fetchPlayer()).adPlacements);
  page.mainWindow.ytInitialPlayerResponse = playerData();
  assert.ok(page.mainWindow.ytInitialPlayerResponse.adPlacements);
  assert.equal(await page.warningProbe(), true);
});

test('public page config cannot write extension storage or send a privileged message', async () => {
  const page = fixture();
  page.loadMain();
  page.loadIsolated();
  await page.resolveSettings({ enabled: false });
  page.config(true); // The public signal may control only the local MAIN helper.
  assert.equal('adPlacements' in await page.fetchPlayer(), false);
  assert.deepEqual(page.storageWrites, []);
  assert.deepEqual(page.messages, []);
  page.emit('yt-navigate-finish'); // Isolated world resends the unchanged saved pause.
  assert.ok((await page.fetchPlayer()).adPlacements);
  assert.deepEqual(page.storageWrites, []);
  assert.deepEqual(page.messages, []);
});
