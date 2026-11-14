import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/content/protect.js", import.meta.url), "utf8");
const sandbox = { module: { exports: {} } };
vm.runInNewContext(source, sandbox, { filename: "protect.js" });
const { isSiteAllowed, isYouTubeHost, resolveFeatures, isExplicitAdState, getAdSeekTarget } = sandbox.module.exports;
const playingAd = { adShowing: true, hasAdIndicator: true, duration: 30, currentTime: 3, readyState: 4, paused: false, seeking: false };

test("site exceptions apply to a hostname and its subdomains, not lookalike domains", () => {
  assert.equal(isSiteAllowed("example.com", ["example.com"]), true);
  assert.equal(isSiteAllowed("video.example.com", ["Example.COM."]), true);
  assert.equal(isSiteAllowed("notexample.com", ["example.com"]), false);
  assert.equal(isSiteAllowed("example.com.evil.test", ["example.com"]), false);
  assert.equal(isSiteAllowed("example.com", ["", null]), false);
  assert.equal(isSiteAllowed("example.com", "example.com"), false);
});

test("YouTube-specific actions are restricted to YouTube hostnames", () => {
  for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com"]) assert.equal(isYouTubeHost(host), true);
  for (const host of ["notyoutube.com", "youtube.com.example.org", "youtu.be", ""]) assert.equal(isYouTubeHost(host), false);
});

test("master pause and site exceptions disable both page features", () => {
  for (const settings of [{ enabled: false }, { siteAllowlist: ["youtube.com"] }]) {
    const result = resolveFeatures(settings, "www.youtube.com");
    assert.equal(result.cosmetic, false);
    assert.equal(result.youtube, false);
  }
});

test("cosmetic and YouTube page features can be changed independently of network filters", () => {
  const youtubeOnly = resolveFeatures({ ads: false, trackers: false, cosmetic: false, youtube: true }, "youtube.com");
  assert.equal(youtubeOnly.cosmetic, false);
  assert.equal(youtubeOnly.youtube, true);
  const cosmeticOnly = resolveFeatures({ cosmetic: true, youtube: false }, "youtube.com");
  assert.equal(cosmeticOnly.cosmetic, true);
  assert.equal(cosmeticOnly.youtube, false);
  assert.equal(resolveFeatures({}, "example.com").youtube, false);
});

test("ad-state guard requires an exact known player class token", () => {
  assert.equal(isExplicitAdState("html5-video-player ad-showing ad-created"), true);
  assert.equal(isExplicitAdState("ad-interrupting html5-video-player"), true);
  for (const state of ["html5-video-player", "not-ad-showing", "ad-showing-finished", "", null]) {
    assert.equal(isExplicitAdState(state), false);
  }
});

test("seek requires explicit ad state plus a visible ad indicator", () => {
  assert.equal(getAdSeekTarget(playingAd), 30);
  assert.equal(getAdSeekTarget({ ...playingAd, adShowing: false }), null);
  assert.equal(getAdSeekTarget({ ...playingAd, hasAdIndicator: false }), null);
});

test("seek cannot change live, loading, paused, already seeking, or finished media", () => {
  for (const duration of [Infinity, NaN, 0, -1, 0.25, 601, undefined]) {
    assert.equal(getAdSeekTarget({ ...playingAd, duration }), null);
  }
  for (const currentTime of [NaN, Infinity, -1, 29.9, 30, 40]) {
    assert.equal(getAdSeekTarget({ ...playingAd, currentTime }), null);
  }
  for (const patch of [{ readyState: 0 }, { readyState: 1 }, { readyState: undefined }, { paused: true }, { paused: undefined }, { seeking: true }]) {
    assert.equal(getAdSeekTarget({ ...playingAd, ...patch }), null);
  }
});
