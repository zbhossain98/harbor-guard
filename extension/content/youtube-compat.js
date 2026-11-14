/*
 * YouTube's player can schedule an ad-block warning through a Promise callback
 * containing onAbnormalityDetected. Handle that known callback before the first
 * page script runs; response filtering alone does not stop it.
 *
 * Independent implementation informed by uAssets' public Quick fixes pattern.
 * No page text, requests, account data, or player errors are changed here.
 */
(() => {
  'use strict';

  if (window.location.protocol !== 'https:' || window.location.port
    || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(window.location.hostname)) return;

  let enabled = window.__harborGuardYouTubeEnabled === true;
  let installed = false;
  const callbacks = new WeakMap();
  const functionSource = Function.prototype.toString;
  const detectionMarker = /\bonAbnormalityDetected\b/;

  function guardCallback(callback) {
    if (typeof callback !== 'function') return callback;
    if (callbacks.has(callback)) return callbacks.get(callback);
    let guarded = callback;
    try {
      // Use the intrinsic, never a page-owned callback.toString getter/method.
      if (detectionMarker.test(Reflect.apply(functionSource, callback, []))) {
        guarded = function (...args) {
          // Read settings when the callback executes, including pending work.
          if (!enabled) return Reflect.apply(callback, this, args);
          return undefined;
        };
      }
    } catch { /* Opaque callbacks keep their normal behavior. */ }
    callbacks.set(callback, guarded);
    return guarded;
  }

  try {
    const prototype = window.Promise?.prototype;
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'then');
    if (typeof descriptor?.value === 'function' && descriptor.writable) {
      Object.defineProperty(prototype, 'then', {
        ...descriptor,
        value: new Proxy(descriptor.value, {
          apply(target, receiver, args) {
            if (args.length) args[0] = guardCallback(args[0]);
            // Rejection callbacks and the receiver go straight to native then.
            // Keep brand checks, chaining, species, and rejection propagation.
            return Reflect.apply(target, receiver, args);
          },
        }),
      });
      installed = true;
    }
  } catch { /* Another script's protected Promise API must remain usable. */ }

  document.addEventListener('harbor-guard:youtube-config', (event) => {
    if (typeof event.detail?.enabled === 'boolean') enabled = event.detail.enabled;
  });
  const announceReady = () => document.dispatchEvent(new CustomEvent('harbor-guard:youtube-compat-ready', {
    detail: { installed },
  }));
  document.addEventListener('harbor-guard:youtube-status-request', announceReady);
  announceReady();
})();
