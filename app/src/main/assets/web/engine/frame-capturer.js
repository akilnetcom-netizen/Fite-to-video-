import { rasterizeDocumentToCanvas } from './dom-rasterizer.js';

/**
 * Inspects the iframe stage and chooses direct <canvas> capture if a visible
 * <canvas> covers the viewport, or falls back to full-document rasterization.
 */
export function findViewportCanvas(doc, win) {
  if (!doc) return null;
  const canvases = Array.from(doc.querySelectorAll('canvas'));
  if (canvases.length === 0) return null;

  const vw = win.innerWidth || doc.documentElement.clientWidth || 1280;
  const vh = win.innerHeight || doc.documentElement.clientHeight || 720;
  const viewArea = Math.max(1, vw * vh);

  let best = null;
  let bestArea = 0;

  for (const c of canvases) {
    const rect = c.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const cs = win.getComputedStyle(c);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestArea = area;
      best = c;
    }
  }

  if (!best) return null;

  // Covers >= 65% of viewport OR is the primary visual element without sibling text overlays
  const coverage = bestArea / viewArea;
  if (coverage >= 0.65) {
    return best;
  }

  // Also allow direct capture if it's the only meaningful visual element in body
  const nonScriptChildren = doc.body
    ? Array.from(doc.body.children).filter((el) => !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName))
    : [];
  if (nonScriptChildren.length === 1 && nonScriptChildren[0] === best && bestArea > 0) {
    return best;
  }

  return null;
}

export async function captureIframeFrame(iframe, targetCanvas) {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) throw new Error('Iframe document unavailable');

  const ctx = targetCanvas.getContext('2d');
  const tw = targetCanvas.width;
  const th = targetCanvas.height;
  const vw = win.innerWidth || doc.documentElement.clientWidth || tw;
  const vh = win.innerHeight || doc.documentElement.clientHeight || th;

  const mainCanvas = findViewportCanvas(doc, win);
  if (mainCanvas && mainCanvas.width > 0 && mainCanvas.height > 0) {
    let bg = '#000000';
    try {
      const bodyBg = win.getComputedStyle(doc.body).backgroundColor;
      if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') bg = bodyBg;
    } catch (_) {}
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, tw, th);

    const sw = mainCanvas.width;
    const sh = mainCanvas.height;
    const scale = Math.min(tw / sw, th / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (tw - dw) / 2;
    const dy = (th - dh) / 2;
    ctx.drawImage(mainCanvas, 0, 0, sw, sh, dx, dy, dw, dh);
    return { method: 'canvas' };
  }

  await rasterizeDocumentToCanvas(doc, win, targetCanvas, vw, vh);
  return { method: 'dom' };
}

/**
 * Creates a small 48x27 grayscale buffer to compare consecutive frames
 * quickly during visual-settle duration auto-detection.
 */
export function createSignatureSampler() {
  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = 48;
  probeCanvas.height = 27;
  const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

  return {
    sample(sourceCanvas) {
      probeCtx.drawImage(sourceCanvas, 0, 0, 48, 27);
      const data = probeCtx.getImageData(0, 0, 48, 27).data;
      const lum = new Uint8Array(48 * 27);
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        lum[p] = (data[i] * 3 + data[i + 1] * 6 + data[i + 2]) / 10;
      }
      return lum;
    },
    diff(sigA, sigB) {
      if (!sigA || !sigB || sigA.length !== sigB.length) return 255;
      let total = 0;
      for (let i = 0; i < sigA.length; i++) {
        total += Math.abs(sigA[i] - sigB[i]);
      }
      return total / sigA.length;
    }
  };
}
