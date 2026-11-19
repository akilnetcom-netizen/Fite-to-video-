import { captureIframeFrame, createSignatureSampler } from './frame-capturer.js';

const MAX_DURATION_SEC = 300; // 5 minutes cap
const SETTLE_WINDOW_SEC = 2.0;

const DURATION_GLOBAL_KEYS = [
  'TOTAL',
  'DURATION',
  'duration',
  'total',
  'TOTAL_DURATION',
  'totalDuration',
  'ANIMATION_DURATION',
  'animationDuration',
  'LOOP_DURATION',
  'loopDuration',
  '__DURATION__'
];

const FRAME_GLOBAL_KEYS = [
  'TOTAL_FRAMES',
  'totalFrames',
  'FRAMES',
  'frameCount'
];

export function inspectGlobalDuration(win, fps = 30) {
  if (!win) return null;

  for (const key of DURATION_GLOBAL_KEYS) {
    try {
      const val = win[key];
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        // Heuristic: values > 300 (5 min) up to 300000 are likely milliseconds
        const sec = val > 300 && val <= 300000 ? val / 1000 : val;
        if (sec >= 0.5 && sec <= MAX_DURATION_SEC) {
          return { durationSec: Number(sec.toFixed(2)), source: `window.${key}` };
        }
      }
    } catch (_) {}
  }

  for (const key of FRAME_GLOBAL_KEYS) {
    try {
      const val = win[key];
      if (typeof val === 'number' && Number.isFinite(val) && val > 1) {
        const sec = val / fps;
        if (sec >= 0.5 && sec <= MAX_DURATION_SEC) {
          return { durationSec: Number(sec.toFixed(2)), source: `window.${key} / ${fps}fps` };
        }
      }
    } catch (_) {}
  }

  // Check nested CONFIG / SETTINGS objects
  for (const objKey of ['CONFIG', 'SETTINGS', 'ANIMATION']) {
    try {
      const obj = win[objKey];
      if (obj && typeof obj === 'object') {
        const d = obj.duration ?? obj.DURATION ?? obj.total ?? obj.TOTAL;
        if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
          const sec = d > 300 && d <= 300000 ? d / 1000 : d;
          if (sec >= 0.5 && sec <= MAX_DURATION_SEC) {
            return { durationSec: Number(sec.toFixed(2)), source: `window.${objKey}.duration` };
          }
        }
      }
    } catch (_) {}
  }

  // Check finite CSS/Web animations
  try {
    if (win.document && typeof win.document.getAnimations === 'function') {
      const anims = win.document.getAnimations({ subtree: true });
      let maxFiniteEndMs = 0;
      let hasInfinite = false;
      for (const a of anims) {
        const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        if (!timing) continue;
        if (timing.endTime === Infinity) {
          hasInfinite = true;
        } else if (Number.isFinite(timing.endTime) && timing.endTime > maxFiniteEndMs) {
          maxFiniteEndMs = timing.endTime;
        }
      }
      if (!hasInfinite && maxFiniteEndMs >= 500 && maxFiniteEndMs <= MAX_DURATION_SEC * 1000) {
        return { durationSec: Number((maxFiniteEndMs / 1000).toFixed(2)), source: 'CSS/Web Animations' };
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Probes the loaded virtual-clock stage to determine duration:
 * 1) Checks globals & finite CSS animations
 * 2) Otherwise advances virtual clock in 250ms steps until visuals settle for ~2s and audio ends (max 5 min).
 */
export async function detectAnimationDuration({
  loadFreshIframe,
  fps = 30,
  onProgress
}) {
  const iframe = await loadFreshIframe('virtual');
  const win = iframe.contentWindow;
  const vclock = win && win.__VCLOCK__;
  if (!vclock) {
    return { durationSec: 5.0, source: 'Default fallback' };
  }

  // Advance 1 tiny tick so initial scripts/animations register
  await vclock.advance(16);

  const globalHit = inspectGlobalDuration(win, fps);
  if (globalHit) {
    return globalHit;
  }

  // Probe pass with 250ms steps
  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = 320;
  probeCanvas.height = 180;
  const sampler = createSignatureSampler();

  const stepMs = 250;
  const maxSteps = (MAX_DURATION_SEC * 1000) / stepMs;
  const settleStepsNeeded = Math.ceil((SETTLE_WINDOW_SEC * 1000) / stepMs);

  let prevSig = null;
  let staticCount = 0;
  let lastActiveTimeSec = 0;

  for (let step = 0; step < maxSteps; step++) {
    await captureIframeFrame(iframe, probeCanvas);
    const sig = sampler.sample(probeCanvas);
    const diff = sampler.diff(prevSig, sig);
    const curSec = vclock.now() / 1000;
    const audioEndSec = vclock.getMaxAudioEndSec ? vclock.getMaxAudioEndSec() : 0;

    if (prevSig && diff < 0.35) {
      staticCount++;
    } else {
      staticCount = 0;
      lastActiveTimeSec = curSec;
    }
    prevSig = sig;

    if (onProgress && step % 4 === 0) {
      onProgress(curSec);
    }

    // Stop if visuals have settled for ~2s AND virtual clock has passed scheduled audio
    if (curSec >= 2.0 && staticCount >= settleStepsNeeded && curSec >= audioEndSec) {
      const detected = Math.max(1.0, Math.min(MAX_DURATION_SEC, Math.max(lastActiveTimeSec + 0.5, audioEndSec)));
      return {
        durationSec: Number(detected.toFixed(1)),
        source: audioEndSec > lastActiveTimeSec ? 'Audio end + visual settle' : 'Visual settle (~2s)'
      };
    }

    await vclock.advance(stepMs);

    // Yield periodically to keep UI responsive
    if (step % 8 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return { durationSec: MAX_DURATION_SEC, source: '5 min max cap' };
}
