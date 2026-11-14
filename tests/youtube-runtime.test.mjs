import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/content/youtube-runtime.js', import.meta.url), 'utf8');
function fixture({ registered = true } = {}) {
  const listeners = new Map();
  let now = 0;
  const state = { debug: 'SSAP, AD', progress: { duration: 30, current: 2 }, playerState: 1, calls: [], statsReads: 0 };
  const video = { isConnected: true, currentSrc: 'blob:fixture', paused: false, ended: false, seeking: false, readyState: 4, volume: 0.7, muted: false, playbackRate: 1.25 };
  const player = {
    querySelector: () => video,
    getStatsForNerds() { state.statsReads++; return { debug_info: state.debug }; },
    getProgressState: () => state.progress,
    getPlayerState: () => state.playerState,
    seekTo: (...args) => state.calls.push(args),
  };
  const window = { __harborGuardYouTubeEnabled: registered, location: { href: 'https://www.youtube.com/watch?v=fixture' } };
  const document = {
    querySelector: () => player,
    addEventListener(name, fn, capture) {
      listeners.set(name, { fn, capture });
    },
  };
  vm.runInNewContext(source, { window, document, performance: { now: () => now } });
  return {
    state, video, player, window, listeners,
    emit(type = 'timeupdate', target = video) { listeners.get(type)?.fn({ type, target }); },
    advance(value) { now += value; },
    configure(enabled) { listeners.get('harbor-guard:youtube-config').fn({ detail: { enabled } }); },
  };
}

test('SSAP ad marker seeks the player segment even without CSS ad classes, preserving preferences', () => {
  const page = fixture();
  page.emit('playing');
  assert.deepEqual(page.state.calls, [[30, true]]);
  assert.equal(page.video.volume, 0.7);
  assert.equal(page.video.playbackRate, 1.25);
  assert.equal(page.video.muted, false);
  assert.equal(page.listeners.get('timeupdate').capture, true);
});

test('normal playback, buffering and near-miss debug strings never seek', () => {
  for (const debug of ['', 'SSAP, VIDEO', 'SSAP, ADVERTISEMENT', 'AD', undefined]) {
    const page = fixture();
    page.state.debug = debug;
    for (let i = 0; i < 20; i++) { page.advance(1000); page.emit(); }
    assert.deepEqual(page.state.calls, [], String(debug));
  }
});

test('paused, loading, seeking, ended, live, invalid and exhausted ad media remain untouched', () => {
  for (const change of [
    { paused: true }, { ended: true }, { seeking: true }, { readyState: 1 },
    { duration: Infinity }, { duration: NaN }, { duration: 1200 }, { duration: 0 },
    { current: 29.9 }, { current: -1 }, { current: NaN }, { playerState: 3 }, { playerState: 2 },
  ]) {
    const page = fixture();
    for (const [key, value] of Object.entries(change)) {
      if (key in page.video) page.video[key] = value;
      else if (key === 'playerState') page.state.playerState = value;
      else page.state.progress[key] = value;
    }
    page.emit('playing');
    assert.deepEqual(page.state.calls, [], JSON.stringify(change));
  }
});

test('a mid-roll marker cannot seek an unchanged normal timeline', () => {
  const page = fixture();
  page.state.debug = 'SSAP, VIDEO';
  page.state.progress.duration = 180;
  page.emit('playing');
  page.state.debug = 'SSAP, AD';
  page.advance(2000);
  page.emit();
  assert.deepEqual(page.state.calls, []);
  page.state.progress.duration = 30;
  page.emit('durationchange');
  assert.deepEqual(page.state.calls, [[30, true]]);
});

test('default pause and live configuration stop runtime actions', () => {
  const page = fixture({ registered: false });
  page.emit('playing');
  assert.deepEqual(page.state.calls, []);
  page.configure(true);
  page.emit('playing');
  assert.equal(page.state.calls.length, 1);
  page.configure(false);
  page.advance(5000);
  page.state.progress.duration = 15;
  page.emit('playing');
  assert.equal(page.state.calls.length, 1);
});

test('failed or ignored seeks have bounded retries and a finite route action budget', () => {
  const page = fixture();
  page.emit('playing');
  page.advance(600); page.emit();
  assert.equal(page.state.calls.length, 1);
  page.advance(1000); page.emit();
  assert.equal(page.state.calls.length, 2);
  for (let i = 0; i < 15; i++) { page.advance(2000); page.emit(); }
  assert.equal(page.state.calls.length, 2);
  for (let i = 0; i < 30; i++) {
    page.state.progress.duration = i % 2 ? 25 : 35;
    page.advance(2000); page.emit();
  }
  assert.equal(page.state.calls.length, 16);
  page.window.location.href = 'https://www.youtube.com/watch?v=second';
  page.advance(2000); page.emit();
  assert.equal(page.state.calls.length, 17);
});

test('synchronous marker or media changes while reading player APIs cannot seek normal content', () => {
  for (const changed of ['marker', 'video']) {
    const page = fixture();
    page.player.getStatsForNerds = () => {
      page.state.statsReads++;
      if (page.state.statsReads === 2) {
        if (changed === 'marker') return { debug_info: 'SSAP, VIDEO' };
        page.player.querySelector = () => ({});
      }
      return { debug_info: page.state.debug };
    };
    page.emit('playing');
    assert.deepEqual(page.state.calls, []);
  }
});

test('preview media and unavailable player APIs cause no action', () => {
  const page = fixture();
  page.emit('playing', {});
  assert.deepEqual(page.state.calls, []);
  page.player.getStatsForNerds = () => { throw new Error('unsupported'); };
  assert.doesNotThrow(() => page.emit('playing'));
  assert.deepEqual(page.state.calls, []);
});
