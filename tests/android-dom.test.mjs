import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../android/app/src/main/assets/youtube-dom.js', import.meta.url), 'utf8');
function setup(withPlayer = true) {
  const observers = [], tasks = new Map(), events = new Map(), styles = new Map();
  let time = 0, next = 1, layouts = 0, clicks = 0, allScans = 0;
  const video = { currentSrc: 'content', duration: 120, currentTime: 5, paused: false, seeking: false, ended: false, readyState: 4 };
  const button = { disabled: false, getBoundingClientRect() { layouts++; return { width: 20, height: 20 }; }, click() { clicks++; } };
  const player = { isConnected: true, className: '', querySelector() { return video; }, querySelectorAll(selector) { return selector.includes('skip') ? [button] : []; } };
  let activePlayer = withPlayer ? player : null;
  const document = {
    documentElement: { appendChild(node) { styles.set(node.id, node); } },
    getElementById(id) { return styles.get(id); }, createElement() { return {}; },
    querySelector(selector) { return selector === '#movie_player' ? activePlayer : null; },
    querySelectorAll() { allScans++; return []; },
    addEventListener(type, fn) { events.set(type, fn); }
  };
  class Observer {
    constructor(callback) { this.callback = callback; this.live = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; this.live = true; }
    disconnect() { this.live = false; }
  }
  const window = {}, location = new URL('https://m.youtube.com/watch?v=abcdefghijk');
  const context = vm.createContext({ window, location, document, MutationObserver: Observer, getComputedStyle: () => ({ visibility: 'visible' }), performance: { now: () => time },
    setTimeout(fn, delay) { const id = next++; tasks.set(id, { fn, at: time + delay }); return id; } });
  vm.runInContext(source, context);
  function advance(ms) {
    const until = time + ms;
    for (let step = 0; step < 100; step++) {
      const pending = [...tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending) break;
      time = pending[1].at; tasks.delete(pending[0]); pending[1].fn();
    }
    time = until;
  }
  return { player, video, document, observers, styles, advance,
    mutation(target) { for (const observer of observers) if (observer.live && observer.target === target) observer.callback([]); },
    mount() { activePlayer = player; }, event(type) { events.get(type)?.({ target: video }); },
    counters() { return { layouts, clicks, allScans, timers: tasks.size }; } };
}
test('ordinary player and page mutations do not scan the document or force layout', () => {
  const env = setup(); env.advance(100);
  for (let i = 0; i < 1000; i++) { env.mutation(env.document); env.advance(10); }
  assert.deepEqual(env.counters(), { layouts: 0, clicks: 0, allScans: 0, timers: 0 });
  assert.equal(env.observers.filter(o => o.live && o.target === env.document).length, 0);
});
test('player discovery disconnects after mounting and CSS continues to hide ad slots', () => {
  const env = setup(false); env.advance(100);
  assert.equal(env.observers.filter(o => o.live && o.target === env.document).length, 1);
  env.mount(); env.mutation(env.document); env.advance(100);
  assert.equal(env.observers.filter(o => o.live && o.target === env.document).length, 0);
  assert.ok(env.styles.get('harbortube-ad-slots').textContent.includes('ytm-ad-slot-renderer'));
  assert.equal(env.counters().allScans, 0);
});
test('a player ad-class change still finds and clicks a visible skip control with bounded retries', () => {
  const env = setup(); env.advance(100);
  env.player.className = 'ad-showing'; env.mutation(env.player); env.advance(100);
  assert.equal(env.counters().clicks, 1);
  env.advance(1000); assert.equal(env.counters().clicks, 1);
  env.advance(20000); assert.equal(env.counters().clicks, 4);
  assert.equal(env.video.currentTime, 5);
});
test('normal media events do not seek, click or introduce a continuing timer', () => {
  const env = setup(); env.advance(100);
  for (let i = 0; i < 20; i++) { env.event('playing'); env.advance(100); }
  assert.equal(env.video.currentTime, 5); assert.equal(env.counters().clicks, 0);
  assert.equal(env.counters().layouts, 0); assert.equal(env.counters().timers, 0);
});
