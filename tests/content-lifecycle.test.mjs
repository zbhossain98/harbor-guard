import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/content/protect.js", import.meta.url), "utf8");

// A small browser boundary fake: run the complete content script against
// storage, DOM, observers and timers without reproducing its feature guards.
async function launch({ hostname = "www.youtube.com", settings = {}, withSlot = false, adClass = "", skip = false, seekBehavior = "accept", hasRoot = true, storageDeferred = false, storageFailure = false } = {}) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const observers = [];
  const storageListeners = [];
  const sent = [];
  const seekWrites = [];
  const documentEvents = new Map();
  const emittedEvents = [];
  let releaseStorage;
  class Element {
    constructor(className = "") {
      this.nodeType = 1;
      this.isConnected = true;
      this.attributes = new Map();
      this.hidden = false;
      this.children = [];
      this.className = className;
      this.listeners = new Map();
      this.css = { display: "block", visibility: "visible", opacity: "1" };
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    getBoundingClientRect() { return { width: 300, height: 200 }; }
    append(child) { this.children.push(child); child.isConnected = true; }
    remove() { this.isConnected = false; }
    matches(selector) { return selector.split(",").some((part) => part.startsWith(".") && this.className.split(/\s+/).includes(part.slice(1))); }
    closest(selector) { return this.matches(selector) ? this : null; }
    querySelectorAll() { return []; }
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    emit(name) { for (const callback of this.listeners.get(name) || []) callback({ type: name, target: this }); }
  }
  class Observer {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; this.active = true; }
    disconnect() { this.active = false; }
  }
  const slot = new Element();
  const root = new Element();
  root.querySelectorAll = (selector) => withSlot && selector.includes("adsbygoogle") ? [slot] : [];
  const player = new Element();
  player.className = `html5-video-player ${adClass}`;
  const indicator = new Element("ytp-ad-text");
  function makeVideo() {
    const element = new Element("html5-main-video");
    Object.assign(element, { duration: 30, currentSrc: "blob:ad-a", readyState: 4, paused: false, seeking: false, ended: false, muted: false, volume: 0.7, playbackRate: 1 });
    let time = 3;
    element.moveTo = (value) => { time = value; };
    Object.defineProperty(element, "currentTime", {
      get: () => time,
      set: (value) => {
        seekWrites.push(value);
        if (seekBehavior === "throw") throw new Error("media not seekable");
        if (seekBehavior === "accept") time = value;
      },
    });
    return element;
  }
  let video = makeVideo();
  const skipButton = new Element(typeof skip === "string" ? skip : "ytp-ad-skip-button-modern");
  skipButton.disabled = false;
  let clicks = 0;
  skipButton.click = () => { clicks += 1; };
  player.querySelector = () => video;
  player.querySelectorAll = (selector) => {
    return [indicator, ...(skip ? [skipButton] : [])].filter((element) => element.matches(selector));
  };
  const context = {
    document: {
      documentElement: hasRoot ? root : null,
      head: hasRoot ? root : null,
      createElement: () => new Element(),
      querySelector: () => player,
      addEventListener: (name, callback) => documentEvents.set(name, callback),
      dispatchEvent: (event) => {
        emittedEvents.push(event);
        documentEvents.get(event.type)?.(event);
        return true;
      },
    },
    window: { addEventListener() {} },
    location: { hostname, href: `https://${hostname}/watch?v=test` },
    chrome: {
      storage: {
        local: {
          get: () => {
            if (storageFailure) return Promise.reject(new Error("storage unavailable"));
            if (storageDeferred) return new Promise((resolve) => { releaseStorage = () => resolve({ settings }); });
            return Promise.resolve({ settings });
          },
        },
        onChanged: { addListener: (callback) => storageListeners.push(callback) },
      },
      runtime: { id: "a".repeat(32), sendMessage: async (message) => { sent.push(message); return { ok: true }; } },
    },
    getComputedStyle: (element) => element.css,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    MutationObserver: Observer,
    performance: { now: () => now },
    setTimeout: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(source, context, { filename: "protect.js" });
  await Promise.resolve();
  const advance = (milliseconds) => {
    const target = now + milliseconds;
    let steps = 0;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      assert.ok(++steps < 1000, "content script must not poll indefinitely");
      const [id, timer] = due;
      now = timer.at;
      timers.delete(id);
      timer.callback();
    }
    now = target;
  };
  const changeSettings = (value) => storageListeners.forEach((listener) => listener({ settings: { newValue: value } }, "local"));
  const mutatePlayer = (target, attributeName) => {
    for (const observer of observers) {
      if (observer.active && observer.target === player && observer.options.attributeFilter.includes(attributeName)) {
        observer.callback([{ type: "attributes", target, attributeName }]);
      }
    }
  };
  const changePlayerClass = (value) => {
    player.className = `html5-video-player ${value}`;
    mutatePlayer(player, "class");
  };
  const setMedia = (values, event) => {
    if ("currentTime" in values) video.moveTo(values.currentTime);
    for (const [key, value] of Object.entries(values)) if (key !== "currentTime") video[key] = value;
    if (event) video.emit(event);
  };
  const replaceVideo = () => { video.isConnected = false; video = makeVideo(); return video; };
  const createRoot = () => {
    context.document.documentElement = root;
    context.document.head = root;
    for (const observer of observers) {
      if (observer.active && observer.target === context.document) observer.callback([{ addedNodes: [root], removedNodes: [] }]);
    }
  };
  return { slot, root, player, get video() { return video; }, indicator, skipButton, seekWrites, sent, timers, observers, documentEvents, emittedEvents, releaseStorage: async () => { releaseStorage(); await Promise.resolve(); }, advance, changeSettings, changePlayerClass, mutatePlayer, setMedia, replaceVideo, createRoot, clicks: () => clicks };
}

test("MAIN-world configuration waits for saved settings, including before the DOM exists", async () => {
  const page = await launch({ hasRoot: false, settings: { enabled: false }, storageDeferred: true });
  page.documentEvents.get("harbor-guard:youtube-ready")();
  assert.equal(page.emittedEvents.length, 0);
  await page.releaseStorage();
  assert.equal(page.emittedEvents.length, 1);
  assert.equal(page.emittedEvents[0].type, "harbor-guard:youtube-config");
  assert.equal(page.emittedEvents[0].detail.enabled, false);
  page.documentEvents.get("harbor-guard:youtube-ready")();
  assert.equal(page.emittedEvents.at(-1).detail.enabled, false);
  page.changeSettings({ enabled: true });
  assert.equal(page.emittedEvents.at(-1).detail.enabled, true);
});

test("a newer settings event cannot be overwritten by an older startup storage read", async () => {
  const page = await launch({ storageDeferred: true, settings: { enabled: true }, adClass: "ad-showing" });
  page.changeSettings({ enabled: false });
  await page.releaseStorage();
  page.advance(30000);
  assert.equal(page.emittedEvents.at(-1).detail.enabled, false);
  assert.deepEqual(page.seekWrites, []);
  assert.equal(page.timers.size, 0);
});

test("failed storage startup leaves both page helpers disabled", async () => {
  const page = await launch({ storageFailure: true, adClass: "ad-showing", withSlot: true });
  page.advance(30000);
  page.documentEvents.get("harbor-guard:youtube-ready")();
  assert.ok(page.emittedEvents.length > 0);
  assert.ok(page.emittedEvents.every((event) => event.type === 'harbor-guard:youtube-config' && event.detail.enabled === false));
  assert.equal(page.slot.getAttribute("data-pcguard-hidden"), null);
  assert.deepEqual(page.seekWrites, []);
});

test("document_start waits for a document root before observing and cleaning the page", async () => {
  const page = await launch({ hasRoot: false, withSlot: true, hostname: "example.com" });
  page.advance(1000);
  assert.equal(page.slot.getAttribute("data-pcguard-hidden"), null);
  assert.equal(page.timers.size, 0);
  page.createRoot();
  page.advance(200);
  assert.equal(page.slot.getAttribute("data-pcguard-hidden"), "a".repeat(32));
});

test("settings paused before the document exists are respected when it appears", async () => {
  const page = await launch({ hasRoot: false, withSlot: true, adClass: "ad-showing" });
  page.changeSettings({ enabled: false });
  page.createRoot();
  page.advance(30000);
  assert.equal(page.slot.getAttribute("data-pcguard-hidden"), null);
  assert.deepEqual(page.seekWrites, []);
  assert.equal(page.observers.some((observer) => observer.active), false);
  assert.equal(page.timers.size, 0);
  page.changeSettings({ enabled: true });
  page.advance(1000);
  assert.equal(page.slot.getAttribute("data-pcguard-hidden"), "a".repeat(32));
  assert.deepEqual(page.seekWrites, [30]);
});

test("normal YouTube playback is untouched and idle pages are not polled", async () => {
  const page = await launch({ skip: true });
  page.advance(30000);
  assert.equal(page.clicks(), 0);
  assert.deepEqual(page.seekWrites, []);
  assert.equal(page.video.muted, false);
  assert.equal(page.video.volume, 0.7);
  assert.equal(page.video.playbackRate, 1);
  assert.equal(page.timers.size, 0);
  assert.deepEqual(page.sent, []);
});

test("site exceptions immediately restore hidden slots and stop page observers", async () => {
  const page = await launch({ withSlot: true, hostname: "news.example.com" });
  page.advance(200);
  assert.equal(page.slot.getAttribute("data-pcguard-hidden"), "a".repeat(32));
  page.changeSettings({ siteAllowlist: ["example.com"] });
  assert.equal(page.slot.getAttribute("data-pcguard-hidden"), null);
  assert.equal(page.observers.some((observer) => observer.active), false);
  assert.equal(page.root.children.every((element) => !element.isConnected), true);
  page.changeSettings({ siteAllowlist: [] });
  page.advance(200);
  assert.equal(page.slot.getAttribute("data-pcguard-hidden"), "a".repeat(32));
});

test("ad seek happens once, preserves media preferences, and counts only an observed ad exit", async () => {
  const page = await launch({ adClass: "ad-showing" });
  page.advance(1000);
  assert.deepEqual(page.seekWrites, [30]);
  assert.equal(page.video.volume, 0.7);
  assert.equal(page.video.muted, false);
  assert.equal(page.video.playbackRate, 1);
  assert.deepEqual(page.sent, []);
  page.changePlayerClass("ad-showing controls-visible");
  page.advance(300);
  assert.deepEqual(page.seekWrites, [30]);
  page.changePlayerClass("");
  page.advance(200);
  page.advance(10000);
  assert.equal(page.sent.length, 1);
  assert.equal(page.sent[0].type, "reportActivity");
  assert.equal(page.sent[0].kind, "youtubeSkipped");
  assert.equal(page.sent[0].count, 1);
});

test("pausing protection cancels a scheduled ad action", async () => {
  const page = await launch({ adClass: "ad-interrupting" });
  page.advance(200);
  page.changeSettings({ enabled: false });
  page.advance(30000);
  assert.deepEqual(page.seekWrites, []);
  assert.equal(page.clicks(), 0);
  assert.equal(page.timers.size, 0);
});

test("a native skip control gets only bounded, spaced retries per media segment", async () => {
  const page = await launch({ adClass: "ad-showing", skip: true });
  page.setMedia({ duration: Infinity });
  page.advance(200);
  assert.equal(page.clicks(), 1);
  page.changePlayerClass("ad-showing controls-visible");
  page.advance(1000);
  assert.equal(page.clicks(), 1);
  page.advance(1000);
  assert.equal(page.clicks(), 2);
  page.advance(10000);
  assert.equal(page.clicks(), 2);
  page.changePlayerClass("");
  page.advance(200);
  page.changePlayerClass("ad-showing");
  page.advance(200);
  assert.equal(page.clicks(), 3);
});

test("consecutive ad durations and sources re-arm seeking without an ad-class transition", async () => {
  const page = await launch({ adClass: "ad-showing" });
  page.advance(1000);
  assert.deepEqual(page.seekWrites, [30]);
  page.setMedia({ duration: 15, currentTime: 0 });
  page.advance(1000);
  assert.deepEqual(page.seekWrites, [30, 15]);
  page.setMedia({ currentSrc: "blob:ad-b", currentTime: 0 });
  page.advance(1000);
  assert.deepEqual(page.seekWrites, [30, 15, 15]);
});

test("new metadata and replacement video elements re-arm same-duration ads", async () => {
  const page = await launch({ adClass: "ad-showing" });
  page.advance(1000);
  page.setMedia({ currentTime: 0 }, "loadedmetadata");
  page.advance(1000);
  assert.deepEqual(page.seekWrites, [30, 30]);
  const oldVideo = page.video;
  page.replaceVideo();
  page.advance(1000);
  assert.deepEqual(page.seekWrites, [30, 30, 30]);
  assert.equal(oldVideo.listeners.get("loadedmetadata").size, 0);
});

test("same-resource ads restarting after an ended event get a new attempt", async () => {
  const page = await launch({ adClass: "ad-interrupting" });
  page.advance(1000);
  page.setMedia({ ended: true }, "ended");
  page.setMedia({ ended: false, currentTime: 0 });
  page.advance(1000);
  assert.deepEqual(page.seekWrites, [30, 30]);
});

test("late native skip controls are found even without a DOM mutation", async () => {
  for (const selector of ["ytp-ad-skip-button-modern", "ytp-skip-ad-button", "ytp-ad-skip-button"]) {
    const page = await launch({ adClass: "ad-showing", skip: selector });
    page.setMedia({ duration: Infinity });
    page.skipButton.hidden = true;
    page.advance(2000);
    assert.equal(page.clicks(), 0);
    page.skipButton.hidden = false;
    page.advance(400);
    assert.equal(page.clicks(), 1);
  }
});

test("player observer watches delayed ad visibility but ignores ordinary progress-bar styles", async () => {
  const page = await launch({ skip: true });
  page.advance(200);
  const observer = page.observers.find((item) => item.target === page.player);
  for (const name of ["style", "hidden", "aria-hidden", "src"]) assert.equal(observer.options.attributeFilter.includes(name), true);
  assert.equal(observer.options.characterData, true);
  page.mutatePlayer(page.slot, "style");
  assert.equal(page.timers.size, 0);
  page.setMedia({ duration: Infinity });
  page.skipButton.css.display = "none";
  page.changePlayerClass("ad-showing");
  page.advance(200);
  assert.equal(page.clicks(), 0);
  page.skipButton.css.display = "block";
  page.mutatePlayer(page.skipButton, "style");
  page.advance(200);
  assert.equal(page.clicks(), 1);
});

test("a mid-roll marker cannot seek the previous normal video's unchanged media", async () => {
  const page = await launch();
  page.advance(200);
  page.changePlayerClass("ad-showing");
  page.advance(2000);
  assert.deepEqual(page.seekWrites, []);
  page.setMedia({ duration: 15, currentTime: 0 }, "loadedmetadata");
  page.advance(1000);
  assert.deepEqual(page.seekWrites, [15]);
  page.setMedia({ duration: 300, currentTime: 42, currentSrc: "blob:content" });
  page.changePlayerClass("");
  page.advance(30000);
  assert.deepEqual(page.seekWrites, [15]);
  assert.equal(page.video.currentTime, 42);
  assert.equal(page.timers.size, 0);
});

test("ignored or rejected seeks are retried only twice and late skip buttons still work", async () => {
  for (const seekBehavior of ["ignore", "throw"]) {
    const page = await launch({ adClass: "ad-showing", skip: true, seekBehavior });
    page.skipButton.hidden = true;
    page.advance(10000);
    assert.deepEqual(page.seekWrites, [30, 30]);
    page.skipButton.hidden = false;
    page.advance(400);
    assert.equal(page.clicks(), 1);
    assert.deepEqual(page.seekWrites, [30, 30]);
  }
});

test("a failing click does not stop the independent ad-media action", async () => {
  const page = await launch({ adClass: "ad-showing", skip: true });
  page.skipButton.click = () => { throw new Error("detached native control"); };
  page.advance(1000);
  assert.deepEqual(page.seekWrites, [30]);
});

test("a synchronous skip transition cannot seek the newly restored content video", async () => {
  const page = await launch({ adClass: "ad-showing", skip: true });
  page.skipButton.click = () => {
    page.setMedia({ duration: 300, currentTime: 42, currentSrc: "blob:content" });
    page.changePlayerClass("");
  };
  page.advance(30000);
  assert.deepEqual(page.seekWrites, []);
  assert.equal(page.video.currentTime, 42);
  assert.equal(page.timers.size, 0);
});

test("the ad-only watchdog expires even when an ad never becomes actionable", async () => {
  const page = await launch({ adClass: "ad-showing" });
  page.setMedia({ duration: Infinity });
  page.advance(121000);
  assert.equal(page.timers.size, 0);
  assert.deepEqual(page.seekWrites, []);
  assert.deepEqual(page.sent, []);
});

test("same-page YouTube data events do not reset retry limits", async () => {
  const page = await launch({ adClass: "ad-showing", seekBehavior: "ignore" });
  page.advance(3000);
  assert.deepEqual(page.seekWrites, [30, 30]);
  page.documentEvents.get("yt-page-data-updated")();
  page.documentEvents.get("yt-navigate-finish")();
  page.advance(3000);
  assert.deepEqual(page.seekWrites, [30, 30]);
});

test("media changes and class churn cannot extend the ad watchdog deadline", async () => {
  const page = await launch({ adClass: "ad-showing" });
  page.setMedia({ duration: Infinity });
  for (let index = 0; index < 9; index += 1) {
    page.setMedia({ currentSrc: `blob:ad-${index}` });
    page.changePlayerClass(`ad-showing controls-${index}`);
    page.advance(15000);
  }
  assert.equal(page.timers.size, 0);
  assert.deepEqual(page.seekWrites, []);
});

test("repeated metadata resets have a finite per-session action budget", async () => {
  const page = await launch({ adClass: "ad-showing" });
  for (let index = 0; index < 25; index += 1) {
    page.setMedia({ currentTime: 0 }, "loadedmetadata");
    page.advance(1000);
  }
  assert.equal(page.seekWrites.length, 16);
  page.advance(10000);
  assert.equal(page.timers.size, 0);
});

test("turning off only the YouTube helper cancels its watcher while cosmetics remain active", async () => {
  const page = await launch({ adClass: "ad-showing", withSlot: true });
  page.advance(200);
  page.changeSettings({ youtube: false, cosmetic: true });
  page.advance(30000);
  assert.deepEqual(page.seekWrites, []);
  assert.equal(page.slot.getAttribute("data-pcguard-hidden"), "a".repeat(32));
  assert.equal(page.timers.size, 0);
});
