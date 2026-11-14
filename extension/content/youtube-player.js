/*
 * Runs in YouTube's MAIN world so its player can consume a cleaned response.
 * This helper has no extension APIs, storage, network requests, or telemetry.
 * The page can dispatch these public events to change this local helper only;
 * doing so cannot change the extension's saved settings or other protections.
 * Removed ad metadata cannot be restored by toggling off. Reload to restore it.
 */
(() => {
  'use strict';

  const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
  const AD_FIELDS = ['adPlacements', 'playerAds', 'adSlots'];
  const decorated = new WeakSet();
  const playerResponses = new WeakSet();
  const initialFieldGuards = new WeakSet();
  const jsonApi = window.JSON || JSON;
  const parse = jsonApi.parse;
  const stringify = jsonApi.stringify;
  let enabled = window.__harborGuardYouTubeEnabled === true;
  delete window.__harborGuardYouTubeEnabled;

  function isPlayerEndpoint(value) {
    try {
      const url = new URL(value, window.location.href);
      return url.protocol === 'https:' && !url.port
        && YOUTUBE_HOSTS.has(url.hostname)
        && YOUTUBE_HOSTS.has(window.location.hostname)
        && (['/youtubei/v1/player', '/youtubei/v1/playlist', '/youtubei/v1/get_watch', '/youtubei/v1/navigation/resolve_url'].includes(url.pathname)
          || url.pathname === '/watch' && (url.searchParams.has('v') || url.searchParams.has('t'))
          || url.pathname === '/playlist' && url.searchParams.has('list'));
    } catch {
      return false;
    }
  }

  function isPlayerRequest(input) {
    try {
      if (typeof input === 'string') return isPlayerEndpoint(input);
      if (typeof URL !== 'undefined' && input instanceof URL) return isPlayerEndpoint(input.href);
      if (typeof Request !== 'undefined' && input instanceof Request) return isPlayerEndpoint(input.url);
    } catch {
      // Never coerce or consume an unfamiliar fetch input just to inspect it.
    }
    return false;
  }

  function ownValue(value, key) {
    if (!value || typeof value !== 'object') return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  }

  function prefetchedPlayer(value) {
    return ownValue(ownValue(ownValue(ownValue(value, 'endpoint'), 'watchEndpoint'), 'unserializedPrefetchData'), 'playerResponse');
  }

  function removeAdFields(value, depth = 0) {
    if (!enabled || value === null || typeof value !== 'object' || depth > 4) return false;
    let changed = false;
    if (Array.isArray(value)) {
      // Known player API envelopes can be arrays. Do not traverse arbitrary
      // renderer trees, playback data, getters or prototypes.
      for (let i = 0; i < Math.min(value.length, 1000); i++) {
        changed = removeAdFields(ownValue(value, i), depth + 1) || changed;
      }
      return changed;
    }
    // Navigation can deliver the next video's player before /player is called.
    // Only its exact player envelope is ad data; keep the navigation response.
    const prefetched = prefetchedPlayer(value);
    if (prefetched && typeof prefetched === 'object') return removeAdFields(prefetched, depth + 1);
    for (const key of AD_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.configurable && !initialFieldGuards.has(descriptor.get)) {
        delete value[key];
        changed = true;
      }
    }
    changed = removeAdFields(ownValue(value, 'playerResponse'), depth + 1) || changed;
    return changed;
  }

  function protectInitialPlayer(value) {
    if (!enabled || !value || typeof value !== 'object' || Array.isArray(value)) return;
    try {
      removeAdFields(value);
      if (!Object.isExtensible(value)) return;
      for (const key of AD_FIELDS) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && (!descriptor.configurable || initialFieldGuards.has(descriptor.get))) continue;
        const getter = () => undefined;
        initialFieldGuards.add(getter);
        // Prevent later assignments from putting consumed ad metadata back on
        // the same initial object. Paused assignments regain ordinary fields.
        Object.defineProperty(value, key, {
          configurable: true, enumerable: false, get: getter,
          set(next) {
            if (!enabled) Object.defineProperty(this, key, { value: next, configurable: true, enumerable: true, writable: true });
          },
        });
      }
    } catch { /* Protected initial objects retain their native behavior. */ }
  }

  function cleanText(body) {
    if (!enabled || typeof body !== 'string') return body;
    try {
      // YouTube's legacy watch/playlist transport may prepend an anti-XSSI
      // guard. Preserve that guard while cleaning its JSON payload.
      const prefix = body.match(/^\)\]\}'(?:\r?\n)?/)?.[0] || '';
      const value = Reflect.apply(parse, jsonApi, [body.slice(prefix.length)]);
      return removeAdFields(value) ? prefix + Reflect.apply(stringify, jsonApi, [value]) : body;
    } catch {
      return body;
    }
  }

  function isJsonPlayerResponse(response) {
    try {
      if (!response || response.ok !== true) return false;
      if (response.url && !isPlayerEndpoint(response.url)) return false;
      const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      return type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type || '');
    } catch {
      return false;
    }
  }

  function decorateResponse(response) {
    if (!isJsonPlayerResponse(response)) return response;
    playerResponses.add(response);
    if (decorated.has(response) || !Object.isExtensible(response)) return response;
    const json = response.json;
    const text = response.text;
    const clone = response.clone;
    if (![json, text, clone].every((method) => typeof method === 'function')) return response;
    for (const key of ['json', 'text', 'clone']) {
      if (Object.getOwnPropertyDescriptor(response, key)?.configurable === false) return response;
    }

    try {
      Object.defineProperties(response, {
        json: {
          configurable: true,
          writable: true,
          value: function (...args) {
            const result = Reflect.apply(json, this, args);
            if (this !== response) return result;
            return result.then((value) => {
              // Read the current setting when consumed, including in-flight work.
              removeAdFields(value);
              return value;
            });
          },
        },
        text: {
          configurable: true,
          writable: true,
          value: function (...args) {
            const result = Reflect.apply(text, this, args);
            if (this !== response) return result;
            return result.then((body) => {
              return cleanText(body);
            });
          },
        },
        clone: {
          configurable: true,
          writable: true,
          value: function (...args) {
            const result = Reflect.apply(clone, this, args);
            return this === response ? decorateResponse(result) : result;
          },
        },
      });
      decorated.add(response);
    } catch {
      // An unusual, non-decoratable Response still passes through to the player.
    }
    return response;
  }

  // Some player bundles borrow methods directly from Response.prototype,
  // bypassing the decorated instance methods. Scope those reads to responses
  // seen on the supported player routes, including clones and byte/Blob reads.
  const responsePrototype = window.Response?.prototype;
  if (responsePrototype) {
    for (const name of ['json', 'text', 'arrayBuffer', 'blob', 'clone']) {
      const native = responsePrototype[name];
      const descriptor = Object.getOwnPropertyDescriptor(responsePrototype, name);
      if (typeof native !== 'function' || !descriptor?.writable) continue;
      responsePrototype[name] = function harborGuardResponseRead(...args) {
        const result = Reflect.apply(native, this, args);
        if (!playerResponses.has(this)) return result;
        if (name === 'clone') return decorateResponse(result);
        return result.then(async (value) => {
          if (!enabled) return value;
          if (name === 'json') { removeAdFields(value); return value; }
          if (name === 'text') return cleanText(value);
          // Preserve native byte/Blob output types and original Blob MIME type.
          const bytes = name === 'blob' ? await value.arrayBuffer() : value;
          const body = new TextDecoder().decode(bytes);
          const clean = cleanText(body);
          if (clean === body) return value;
          const encoded = new TextEncoder().encode(clean);
          return name === 'blob' ? new Blob([encoded], { type: value.type }) : encoded.buffer;
        });
      };
    }
  }

  function cleanInitialPlayer() {
    if (!enabled) return;
    try {
      protectInitialPlayer(ownValue(window, 'ytInitialPlayerResponse') ?? initialValues.get('ytInitialPlayerResponse'));
      protectInitialPlayer(ownValue(window, 'playerResponse') ?? initialValues.get('playerResponse'));
    } catch {
      // A replaced or protected page object must not break playback.
    }
  }

  const initialValues = new Map();
  for (const key of ['ytInitialPlayerResponse', 'playerResponse']) {
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    // Respect protected or accessor-backed globals owned by another script.
    if (descriptor && (!descriptor.configurable || !descriptor.writable || !('value' in descriptor))) continue;
    initialValues.set(key, descriptor?.value);
    try {
      Object.defineProperty(window, key, {
        configurable: true, enumerable: descriptor?.enumerable ?? true,
        get() { return initialValues.get(key); },
        set(value) {
          protectInitialPlayer(value);
          initialValues.set(key, value);
        },
      });
    } catch { /* Protected globals remain untouched. */ }
  }
  cleanInitialPlayer();

  // YouTube also parses serialized initial player data independently of fetch.
  // Restrict this hook to identifiable player objects; unrelated JSON is intact.
  try {
    jsonApi.parse = function harborGuardParse(...args) {
      const value = Reflect.apply(parse, this, args);
      try {
        if (enabled) {
          const envelopes = [];
          if (Array.isArray(value)) {
            for (let i = 0; i < Math.min(value.length, 1000); i++) envelopes.push(ownValue(value, i));
          } else envelopes.push(value);
          const candidates = envelopes.flatMap((item) => [item, ownValue(item, 'playerResponse'), prefetchedPlayer(item)]);
          for (const candidate of candidates) {
            if (typeof ownValue(ownValue(candidate, 'videoDetails'), 'videoId') === 'string'
              && ownValue(candidate, 'playabilityStatus')) removeAdFields(candidate);
          }
        }
      } catch {
        // A reviver may return a protected object/Proxy; keep its native result.
      }
      return value;
    };
  } catch { /* A read-only JSON API must not prevent the other hooks. */ }

  const xhrPrototype = window.XMLHttpRequest?.prototype;
  if (xhrPrototype && typeof xhrPrototype.open === 'function') {
    const requests = new WeakMap();
    const open = xhrPrototype.open;
    xhrPrototype.open = function harborGuardOpen(...args) {
      const result = Reflect.apply(open, this, args);
      requests.set(this, { player: isPlayerRequest(args[1]), raw: undefined, clean: undefined });
      return result;
    };
    for (const key of ['response', 'responseText']) {
      const descriptor = Object.getOwnPropertyDescriptor(xhrPrototype, key);
      if (!descriptor?.configurable || typeof descriptor.get !== 'function') continue;
      Object.defineProperty(xhrPrototype, key, {
        ...descriptor,
        get() {
          // Read natively first, preserving InvalidStateError and type semantics.
          const value = Reflect.apply(descriptor.get, this, []);
          const request = requests.get(this);
          if (!enabled || !request?.player) return value;
          try {
            if (this.readyState !== 4 || this.status < 200 || this.status >= 300
              || (this.responseURL && !isPlayerEndpoint(this.responseURL))) return value;
            const type = this.getResponseHeader('content-type')?.split(';', 1)[0].trim().toLowerCase();
            if (type !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(type || '')) return value;
            if (this.responseType === 'json' && key === 'response') {
              removeAdFields(value);
            } else if (typeof value === 'string' && (!this.responseType || this.responseType === 'text')) {
              if (request.raw !== value) {
                request.raw = value;
                request.clean = cleanText(value);
              }
              return request.clean;
            }
          } catch { /* Unexpected page-owned XHR metadata passes through. */ }
          return value;
        },
      });
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    // Install once. Turning off leaves a transparent forwarding wrapper instead
    // of replacing another script's fetch wrapper or creating toggle-time races.
    window.fetch = function harborGuardFetch(...args) {
      const result = Reflect.apply(originalFetch, this, args);
      if (!isPlayerRequest(args[0])) return result;
      return result.then(decorateResponse);
    };
  }

  document.addEventListener('harbor-guard:youtube-config', (event) => {
    const value = event.detail?.enabled;
    if (typeof value !== 'boolean') return;
    enabled = value;
    if (enabled) cleanInitialPlayer();
  });
  for (const name of ['DOMContentLoaded', 'yt-navigate-finish', 'yt-page-data-updated']) {
    document.addEventListener(name, cleanInitialPlayer);
  }
  const announceReady = () => document.dispatchEvent(new CustomEvent('harbor-guard:youtube-ready'));
  document.addEventListener('harbor-guard:youtube-status-request', announceReady);
  announceReady();
})();
