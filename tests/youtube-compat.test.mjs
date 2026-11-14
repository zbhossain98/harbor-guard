import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/content/youtube-compat.js', import.meta.url), 'utf8');
const bootstrap = fs.readFileSync(new URL('../extension/content/youtube-bootstrap.js', import.meta.url), 'utf8');

// Each fixture owns its Promise realm; tests never patch Node's Promise API.
function launch({ registered = true, href = 'https://www.youtube.com/watch?v=fixture', setup = '' } = {}) {
  const listeners = new Map();
  const events = [];
  class PageEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const document = {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const callback of listeners.get(event.type) || []) callback(event);
    },
  };
  const context = vm.createContext({ document, location: new URL(href), CustomEvent: PageEvent });
  const evaluate = (code) => vm.runInContext(code, context);
  evaluate('window = globalThis; nativeThen = Promise.prototype.then; warningCount = 0; detector = { onAbnormalityDetected() { warningCount++; return "warning"; } };');
  if (setup) evaluate(setup);
  if (registered) vm.runInContext(bootstrap, context);
  vm.runInContext(source, context, { filename: 'youtube-compat.js' });
  return {
    evaluate, events,
    configure: (enabled) => document.dispatchEvent(new PageEvent('harbor-guard:youtube-config', { detail: { enabled } })),
    probe: () => evaluate('Promise.resolve().then(() => detector.onAbnormalityDetected())'),
    requestStatus: () => document.dispatchEvent(new PageEvent('harbor-guard:youtube-status-request')),
  };
}

test('early YouTube guard prevents the known warning callback before inline page code runs', async () => {
  const page = launch();
  assert.equal(await page.probe(), undefined);
  assert.equal(page.evaluate('warningCount'), 0);
  assert.equal(page.events[0].type, 'harbor-guard:youtube-compat-ready');
  assert.equal(page.events[0].detail.installed, true);
  page.requestStatus();
  assert.equal(page.events.at(-1).detail.installed, true, 'late isolated-world status requests recover readiness');
});

test('guard defaults off and accepts only boolean configuration changes', async () => {
  const page = launch({ registered: false });
  assert.equal(await page.probe(), 'warning');
  page.configure('true');
  assert.equal(await page.probe(), 'warning');
  page.configure(true);
  assert.equal(await page.probe(), undefined);
  page.configure(null);
  assert.equal(await page.probe(), undefined);
  page.configure(false);
  assert.equal(await page.probe(), 'warning');
  assert.equal(page.evaluate('warningCount'), 3);
});

test('callbacks already queued honor pause or resume before their Promise resolves', async () => {
  for (const initiallyEnabled of [true, false]) {
    const page = launch({ registered: initiallyEnabled });
    page.evaluate('pending = new Promise(resolve => { finish = resolve; }).then(value => detector.onAbnormalityDetected(value));');
    page.configure(!initiallyEnabled);
    page.evaluate('finish(42)');
    assert.equal(await page.evaluate('pending'), initiallyEnabled ? 'warning' : undefined);
    assert.equal(page.evaluate('warningCount'), initiallyEnabled ? 1 : 0);
  }
});

test('ordinary fulfillment, rejection, catch, finally, and nonfunction handlers retain native behavior', async () => {
  const page = launch();
  assert.equal(await page.evaluate('Promise.resolve(21).then(value => value * 2)'), 42);
  assert.equal(await page.evaluate('Promise.resolve(21).then(null, undefined)'), 21);
  assert.equal(await page.evaluate('Promise.resolve(21).then()'), 21);
  assert.equal(await page.evaluate('Promise.resolve("onAbnormalityDetected").then(value => value)'), 'onAbnormalityDetected');
  assert.equal(await page.evaluate('Promise.resolve().then(() => { const onAbnormalityDetectedElsewhere = () => 7; return onAbnormalityDetectedElsewhere(); })'), 7);
  assert.equal(await page.evaluate('Promise.reject(8).then(undefined, value => value + 1)'), 9);
  assert.equal(await page.evaluate('Promise.reject(8).catch(() => detector.onAbnormalityDetected())'), 'warning', 'rejection handlers are not suppressed');
  assert.equal(await page.evaluate('Promise.resolve(21).finally(() => { finalValue = 1; })'), 21);
  assert.equal(page.evaluate('finalValue'), 1);
  await assert.rejects(page.evaluate('Promise.resolve().then(() => { throw new Error("keep failure"); })'), /keep failure/);
  await assert.rejects(page.evaluate('Promise.reject(new Error("keep rejection")).then(value => value)'), /keep rejection/);
});

test('source inspection ignores custom toString methods and leaves opaque callbacks alone', async () => {
  const page = launch();
  assert.equal(await page.evaluate(`
    ordinary = value => value + 1;
    Object.defineProperty(ordinary, 'toString', { get() { throw new Error('must not read'); } });
    Promise.resolve(8).then(ordinary);
  `), 9);
  assert.equal(await page.evaluate(`
    spoofed = value => value + 2;
    spoofed.toString = () => 'onAbnormalityDetected';
    Promise.resolve(8).then(spoofed);
  `), 10);
  assert.equal(await page.evaluate('Promise.resolve(8).then(new Proxy(value => value + 3, {}))'), 11);
});

test('native receiver errors, Promise species, and paused callback receivers survive', async () => {
  const page = launch();
  assert.throws(() => page.evaluate('Promise.prototype.then.call({}, value => value)'), { name: 'TypeError' });
  assert.equal(page.evaluate('class PlayerPromise extends Promise {} ; new PlayerPromise(resolve => resolve(1)).then(value => value) instanceof PlayerPromise'), true);
  page.configure(false);
  assert.equal(await page.evaluate(`
    Promise.resolve(17).then(function(value) {
      'use strict';
      detector.onAbnormalityDetected();
      return this === undefined && value === 17;
    });
  `), true);
});

test('toggle cycles do not replace another script\'s later Promise wrapper', async () => {
  const page = launch();
  page.evaluate('guardedThen = Promise.prototype.then; laterThen = function(...args) { return Reflect.apply(guardedThen, this, args); }; Promise.prototype.then = laterThen;');
  page.configure(false);
  page.configure(true);
  assert.equal(page.evaluate('Promise.prototype.then === laterThen'), true);
  assert.equal(await page.probe(), undefined);
});

test('protected Promise APIs fail open and report that the compatibility guard is unavailable', async () => {
  const page = launch({ setup: 'Object.defineProperty(Promise.prototype, "then", { writable: false, configurable: false });' });
  assert.equal(page.evaluate('Promise.prototype.then === nativeThen'), true);
  assert.equal(await page.probe(), 'warning');
  assert.equal(page.events[0].detail.installed, false);
});

test('guard never patches unsupported pages or lookalike YouTube hosts', async () => {
  for (const href of ['https://example.com/', 'https://www.youtube.com.evil.example/', 'http://www.youtube.com/', 'https://www.youtube.com:8443/', 'https://music.youtube.com/']) {
    const page = launch({ href });
    assert.equal(page.evaluate('Promise.prototype.then === nativeThen'), true, href);
    assert.equal(await page.probe(), 'warning', href);
    assert.equal(page.events.length, 0);
  }
});
