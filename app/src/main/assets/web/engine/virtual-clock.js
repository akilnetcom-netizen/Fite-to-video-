import { buildAudioHookSource } from './audio-tracer.js';

/**
 * Generates the deterministic virtual clock + WebGL + Audio tracer pre-script
 * injected BEFORE any page scripts inside the sandboxed srcdoc iframe.
 */
export function buildVirtualClockScript({ mode = 'virtual', baseEpochMs = 1700000000000 } = {}) {
  const audioHook = buildAudioHookSource(mode);
  return `
(function() {
  'use strict';
  if (window.__VCLOCK_INSTALLED__) return;
  window.__VCLOCK_INSTALLED__ = true;

  const MODE = ${JSON.stringify(mode)};
  const diagnostics = {
    webglDetected: false,
    webglForcedPreserve: false,
    externalMediaDetected: false,
    mediaSources: [],
    errors: []
  };
  window.__STAGE_DIAGNOSTICS__ = diagnostics;

  window.addEventListener('error', function(e) {
    diagnostics.errors.push(String(e.message || e.error || 'Script error'));
  });

  // Hook WebGL context creation to ensure preserveDrawingBuffer = true in virtual mode
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs) {
    const t = String(type || '').toLowerCase();
    if (t === 'webgl' || t === 'webgl2' || t === 'experimental-webgl') {
      diagnostics.webglDetected = true;
      if (MODE === 'virtual' && (!attrs || attrs.preserveDrawingBuffer !== true)) {
        diagnostics.webglForcedPreserve = true;
        const patched = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
        return origGetContext.call(this, type, patched);
      }
    }
    return origGetContext.apply(this, arguments);
  };

  // Install WebAudio & MediaElement tracer/hook
  ${audioHook}

  if (MODE !== 'virtual') {
    window.__VCLOCK__ = {
      mode: 'realtime',
      now: function() { return performance.now(); },
      advance: async function() { return { timeMs: performance.now() }; },
      getMaxAudioEndSec: function() { return 0; }
    };
    return;
  }

  // Deterministic Virtual Clock
  let virtualTimeMs = 0;
  const BASE_EPOCH = ${Number(baseEpochMs)};
  const OrigDate = window.Date;
  const origPerfNow = window.performance && window.performance.now
    ? window.performance.now.bind(window.performance)
    : function() { return 0; };

  if (window.performance) {
    try {
      Object.defineProperty(window.performance, 'now', {
        configurable: true,
        writable: true,
        value: function() { return virtualTimeMs; }
      });
    } catch (_) {
      window.performance.now = function() { return virtualTimeMs; };
    }
  }

  function VirtualDate(...args) {
    if (!(this instanceof VirtualDate)) {
      return new OrigDate(BASE_EPOCH + virtualTimeMs).toString();
    }
    if (args.length === 0) {
      return new OrigDate(BASE_EPOCH + virtualTimeMs);
    }
    return new OrigDate(...args);
  }
  VirtualDate.prototype = OrigDate.prototype;
  Object.setPrototypeOf(VirtualDate, OrigDate);
  VirtualDate.now = function() { return BASE_EPOCH + virtualTimeMs; };
  VirtualDate.parse = OrigDate.parse;
  VirtualDate.UTC = OrigDate.UTC;
  window.Date = VirtualDate;

  let nextTimerId = 1;
  const timers = new Map();
  let nextRafId = 1;
  let rafQueue = [];

  window.requestAnimationFrame = function(cb) {
    const id = nextRafId++;
    if (typeof cb === 'function') {
      rafQueue.push({ id: id, cb: cb });
    }
    return id;
  };

  window.cancelAnimationFrame = function(id) {
    rafQueue = rafQueue.filter(function(item) { return item.id !== id; });
  };

  window.setTimeout = function(fn, delay) {
    const id = nextTimerId++;
    const args = Array.prototype.slice.call(arguments, 2);
    const ms = Math.max(0, Number(delay) || 0);
    timers.set(id, {
      id: id,
      fn: fn,
      args: args,
      runAt: virtualTimeMs + ms,
      interval: null
    });
    return id;
  };

  window.clearTimeout = function(id) {
    timers.delete(id);
  };

  window.setInterval = function(fn, delay) {
    const id = nextTimerId++;
    const args = Array.prototype.slice.call(arguments, 2);
    const interval = Math.max(1, Number(delay) || 1);
    timers.set(id, {
      id: id,
      fn: fn,
      args: args,
      runAt: virtualTimeMs + interval,
      interval: interval
    });
    return id;
  };

  window.clearInterval = function(id) {
    timers.delete(id);
  };

  function runTimer(timer) {
    try {
      if (typeof timer.fn === 'function') {
        timer.fn.apply(window, timer.args);
      } else if (typeof timer.fn === 'string') {
        (new Function(timer.fn))();
      }
    } catch (err) {
      diagnostics.errors.push(String(err && err.message ? err.message : err));
    }
  }

  function syncCssAnimations(timeMs) {
    if (typeof document.getAnimations !== 'function') return;
    try {
      const anims = document.getAnimations({ subtree: true });
      for (let i = 0; i < anims.length; i++) {
        const anim = anims[i];
        try {
          if (anim.playState === 'running') {
            anim.pause();
          }
          anim.currentTime = timeMs;
        } catch (_) {}
      }
    } catch (_) {}
  }

  async function syncVideoElements(timeMs) {
    const videos = document.querySelectorAll('video');
    if (!videos || videos.length === 0) return;
    diagnostics.externalMediaDetected = true;
    const targetSec = timeMs / 1000;
    const seekPromises = [];
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      try {
        if (!v.paused) v.pause();
        v.autoplay = false;
        if (v.readyState >= 1) {
          const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : targetSec;
          const clamped = v.loop && dur > 0 ? (targetSec % dur) : Math.min(dur, targetSec);
          if (Math.abs(v.currentTime - clamped) > 0.002) {
            seekPromises.push(new Promise(function(resolve) {
              let done = false;
              const finish = function() {
                if (!done) {
                  done = true;
                  v.removeEventListener('seeked', finish);
                  resolve();
                }
              };
              v.addEventListener('seeked', finish);
              setTimeoutOrig(finish, 120);
              v.currentTime = clamped;
            }));
          }
        }
      } catch (_) {}
    }
    if (seekPromises.length > 0) {
      await Promise.all(seekPromises);
    }
  }

  const setTimeoutOrig = (function() {
    // Keep a tiny real-time fallback only for internal seek timeout guard using microtask/Promise or native handle
    return function(fn, ms) {
      let cancelled = false;
      const start = origPerfNow();
      Promise.resolve().then(function check() {
        if (cancelled) return;
        if (origPerfNow() - start >= ms) fn();
        else Promise.resolve().then(check);
      });
      return function() { cancelled = true; };
    };
  })();

  window.__VCLOCK__ = {
    mode: 'virtual',
    now: function() { return virtualTimeMs; },
    getAudioGraph: function() { return window.__AUDIO_TRACER__ ? window.__AUDIO_TRACER__.exportGraph() : null; },
    getMaxAudioEndSec: function() { return window.__AUDIO_TRACER__ ? window.__AUDIO_TRACER__.getMaxEndSec() : 0; },
    advance: async function(dtMs) {
      const step = Math.max(0, Number(dtMs) || 0);
      const targetTime = virtualTimeMs + step;

      // 1. Drain due setTimeout / setInterval in chronological order
      let safety = 0;
      while (safety++ < 4000) {
        let nextTimer = null;
        timers.forEach(function(t) {
          if (t.runAt <= targetTime && (!nextTimer || t.runAt < nextTimer.runAt)) {
            nextTimer = t;
          }
        });
        if (!nextTimer) break;
        virtualTimeMs = nextTimer.runAt;
        if (nextTimer.interval !== null) {
          nextTimer.runAt += nextTimer.interval;
        } else {
          timers.delete(nextTimer.id);
        }
        runTimer(nextTimer);
      }

      virtualTimeMs = targetTime;

      // 2. Drive CSS & Web Animations API
      syncCssAnimations(virtualTimeMs);

      // 3. Pause & seek <video> elements
      await syncVideoElements(virtualTimeMs);

      // 4. Flush requestAnimationFrame queue for this frame
      const currentRafs = rafQueue.slice();
      rafQueue = [];
      for (let i = 0; i < currentRafs.length; i++) {
        try {
          currentRafs[i].cb(virtualTimeMs);
        } catch (err) {
          diagnostics.errors.push(String(err && err.message ? err.message : err));
        }
      }

      // Sync CSS animations again in case rAF callbacks triggered new classes/transitions
      syncCssAnimations(virtualTimeMs);

      return { timeMs: virtualTimeMs };
    }
  };
})();
`;
}

/**
 * Injects the virtual clock pre-script BEFORE any page scripts inside raw HTML.
 */
export function injectScriptIntoHtml(rawHtml, preScriptCode) {
  const tag = `<script data-vclock="true">\n${preScriptCode}\n</script>`;
  if (/<head(\s[^>]*)?>/i.test(rawHtml)) {
    return rawHtml.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n${tag}`);
  }
  if (/<html(\s[^>]*)?>/i.test(rawHtml)) {
    return rawHtml.replace(/<html(\s[^>]*)?>/i, (m) => `${m}\n<head>${tag}</head>`);
  }
  if (/<!doctype[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<!doctype[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  }
  return `${tag}\n${rawHtml}`;
}
