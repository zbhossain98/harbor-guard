import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../extension/lib/settings.js';

let sequence = 0;
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const popup = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` };
const content = { id: extensionId, url: 'https://www.youtube.com/watch?v=not-stored', tab: { id: 1 }, frameId: 0 };

async function setup(stored = {}) {
  const state = { stored: structuredClone(stored), enabled: ['ads', 'trackers'], dynamic: [], scripts: [], failUpdate: false, failScript: false, failStorage: false };
  let onMessage;
  globalThis.chrome = {
    runtime: {
      id: extensionId,
      onMessage: { addListener(listener) { onMessage = listener; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    storage: { local: {
      async get(keys) { return structuredClone(Object.fromEntries(keys.filter((key) => key in state.stored).map((key) => [key, state.stored[key]]))); },
      async set(value) {
        if (state.failStorage) { state.failStorage = false; throw new Error('Simulated storage failure'); }
        Object.assign(state.stored, structuredClone(value));
      },
    } },
    scripting: {
      async getRegisteredContentScripts({ ids }) { return structuredClone(state.scripts.filter((script) => ids.includes(script.id))); },
      async registerContentScripts(scripts) { state.scripts.push(...structuredClone(scripts)); },
      async updateContentScripts(scripts) { state.scripts = structuredClone(scripts); },
      async unregisterContentScripts({ ids }) {
        if (state.failScript) { state.failScript = false; throw new Error('Simulated script failure'); }
        state.scripts = state.scripts.filter((script) => !ids.includes(script.id));
      },
    },
    declarativeNetRequest: {
      async getEnabledRulesets() { return [...state.enabled]; },
      async getDynamicRules() { return structuredClone(state.dynamic); },
      async updateEnabledRulesets(change) {
        if (state.failUpdate) { state.failUpdate = false; throw new Error('Simulated browser failure'); }
        state.enabled = state.enabled.filter((id) => !(change.disableRulesetIds || []).includes(id));
        state.enabled = [...new Set([...state.enabled, ...(change.enableRulesetIds || [])])];
      },
      async updateDynamicRules(change) {
        state.dynamic = state.dynamic.filter((rule) => !change.removeRuleIds.includes(rule.id)).concat(structuredClone(change.addRules));
      },
    },
  };
  await import(`../extension/background.js?test=${++sequence}`);
  const send = (message, sender = popup) => new Promise((resolve) => {
    assert.equal(onMessage(message, sender, resolve), true);
  });
  assert.equal((await send({ type: 'getState' })).ok, true);
  return { state, send };
}

test('worker restores a paused state before replying and serializes concurrent patches', { timeout: 5000 }, async () => {
  const { state, send } = await setup({ settings: { ...DEFAULT_SETTINGS, enabled: false } });
  assert.deepEqual(state.enabled, []);
  assert.deepEqual(state.scripts, []);
  await Promise.all([
    send({ type: 'updateSettings', patch: { ads: false } }),
    send({ type: 'updateSettings', patch: { youtube: false } }),
    send({ type: 'updateSettings', patch: { enabled: true } }),
  ]);
  const reply = await send({ type: 'getState' });
  assert.equal(reply.state.settings.ads, false);
  assert.equal(reply.state.settings.youtube, false);
  assert.deepEqual(reply.state.rules.enabledRulesets, ['trackers']);
  assert.deepEqual(reply.state.stats, { cosmeticHidden: 0, youtubeSkipped: 0 });
});

test('early YouTube injection follows saved settings and domain-boundary site exceptions', async () => {
  const { state, send } = await setup();
  const script = state.scripts[0];
  assert.equal(script.world, 'MAIN');
  assert.equal(script.runAt, 'document_start');
  assert.equal(script.persistAcrossSessions, true);
  assert.deepEqual(script.js, ['content/youtube-bootstrap.js', 'content/youtube-compat.js', 'content/youtube-recovery.js', 'content/youtube-runtime.js', 'content/youtube-player.js']);
  await send({ type: 'toggleSite', hostname: 'www.youtube.com', allowed: true });
  assert.deepEqual(state.scripts[0].matches, ['https://youtube.com/*', 'https://m.youtube.com/*']);
  await send({ type: 'toggleSite', hostname: 'youtube.com', allowed: true });
  assert.deepEqual(state.scripts, []);
  await send({ type: 'toggleSite', hostname: 'youtube.com', allowed: false });
  assert.deepEqual(state.scripts[0].matches, ['https://youtube.com/*', 'https://m.youtube.com/*']);
  await send({ type: 'updateSettings', patch: { youtube: false } });
  assert.deepEqual(state.scripts, []);
});

test('script and storage failures roll back network rules and persisted injection together', async () => {
  for (const failure of ['failScript', 'failStorage']) {
    const { state, send } = await setup();
    const original = structuredClone(state.scripts);
    state[failure] = true;
    const reply = await send({ type: 'updateSettings', patch: { enabled: false } });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /Simulated/);
    assert.equal(state.stored.settings.enabled, true);
    assert.deepEqual(state.enabled, ['ads', 'trackers']);
    assert.deepEqual(state.scripts, original);
  }
});

test('content may read settings and report actions but cannot mutate protection', { timeout: 5000 }, async () => {
  const { state, send } = await setup();
  assert.equal((await send({ type: 'getSettings' }, content)).ok, true);
  for (const message of [
    { type: 'updateSettings', patch: { enabled: false } },
    { type: 'toggleSite', hostname: 'example.com', allowed: true },
    { type: 'resetStats' },
    { type: 'getState' },
  ]) {
    assert.equal((await send(message, content)).ok, false);
  }
  assert.equal((await send({ type: 'getSettings' }, { ...content, id: 'other' })).ok, false);
  assert.equal(state.stored.settings.enabled, true);
  assert.equal((await send({ type: 'reportActivity', kind: 'youtubeSkipped', count: 2 }, content)).counted, 2);
  const reply = await send({ type: 'getState' });
  assert.equal(reply.state.stats.youtubeSkipped, 2);
  assert.equal(JSON.stringify(state.stored).includes('not-stored'), false);
  assert.deepEqual(Object.keys(reply.state.activity[0]).sort(), ['at', 'count', 'kind']);
});

test('browser API failure preserves persisted settings and returns an explicit error', { timeout: 5000 }, async () => {
  const { state, send } = await setup();
  state.failUpdate = true;
  const reply = await send({ type: 'updateSettings', patch: { enabled: false } });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Simulated browser failure/);
  assert.equal(state.stored.settings.enabled, true);
  assert.deepEqual(state.enabled, ['ads', 'trackers']);
});

test('allowlisting and feature toggles suppress activity; reset removes all activity', { timeout: 5000 }, async () => {
  const { send } = await setup();
  const report = () => send({ type: 'reportActivity', kind: 'youtubeSkipped', count: 2 }, content);
  await report();
  await send({ type: 'toggleSite', hostname: 'youtube.com', allowed: true });
  assert.equal((await report()).counted, 0);
  await send({ type: 'toggleSite', hostname: 'youtube.com', allowed: false });
  await send({ type: 'updateSettings', patch: { youtube: false } });
  assert.equal((await report()).counted, 0);
  const otherSite = { ...content, url: 'https://example.com' };
  await send({ type: 'updateSettings', patch: { youtube: true } });
  assert.equal((await send({ type: 'reportActivity', kind: 'youtubeSkipped', count: 2 }, otherSite)).counted, 0);
  const reset = await send({ type: 'resetStats' });
  assert.deepEqual(reset.state.stats, { cosmeticHidden: 0, youtubeSkipped: 0 });
  assert.deepEqual(reset.state.activity, []);
});

test('YouTube display ad cleanup counts independently of generic cosmetic cleanup', { timeout: 5000 }, async () => {
  const { send } = await setup({ settings: { ...DEFAULT_SETTINGS, cosmetic: false } });
  const report = { type: 'reportActivity', kind: 'cosmeticHidden', count: 1 };
  assert.equal((await send(report, content)).counted, 1);
  assert.equal((await send(report, { ...content, url: 'https://example.com' })).counted, 0);
  await send({ type: 'updateSettings', patch: { youtube: false } });
  assert.equal((await send(report, content)).counted, 0);
});
