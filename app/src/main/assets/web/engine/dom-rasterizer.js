/**
 * Rasterizes an arbitrary HTML/CSS/SVG document inside a same-origin iframe
 * onto a target 2D canvas using SVG foreignObject with live computed-style baking
 * (reflecting CSS animations driven via document.getAnimations()).
 */

const ANIMATED_STYLE_PROPS = [
  'transform',
  'transformOrigin',
  'opacity',
  'filter',
  'clipPath',
  'backgroundColor',
  'backgroundImage',
  'backgroundPosition',
  'backgroundSize',
  'color',
  'borderColor',
  'borderRadius',
  'boxShadow',
  'textShadow',
  'letterSpacing',
  'width',
  'height',
  'left',
  'top',
  'right',
  'bottom',
  'marginTop',
  'marginLeft',
  'paddingTop',
  'paddingLeft',
  'strokeDashoffset',
  'strokeDasharray',
  'fill',
  'stroke',
  'strokeWidth'
];

function collectDocumentCss(doc) {
  let css = '';
  for (let i = 0; i < doc.styleSheets.length; i++) {
    const sheet = doc.styleSheets[i];
    try {
      const rules = sheet.cssRules;
      if (!rules) continue;
      for (let j = 0; j < rules.length; j++) {
        // Skip @keyframes rules in foreignObject snapshot because we bake computed animated props inline
        if (rules[j].type !== CSSRule.KEYFRAMES_RULE && rules[j].type !== CSSRule.WEBKIT_KEYFRAMES_RULE) {
          css += rules[j].cssText + '\n';
        }
      }
    } catch (_) {
      // Cross-origin stylesheet fallback: copy <style> text if inline
    }
  }
  const styleTags = doc.querySelectorAll('style');
  if (!css && styleTags.length > 0) {
    styleTags.forEach((tag) => {
      css += tag.textContent + '\n';
    });
  }
  return css;
}

function cloneAndBakeNode(origNode, origWin, canvasSnapshots) {
  if (origNode.nodeType === Node.TEXT_NODE) {
    return origNode.cloneNode(false);
  }
  if (origNode.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const tag = origNode.tagName.toUpperCase();
  if (tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'LINK') {
    return null;
  }

  // Convert inner <canvas> elements to <img> snapshots so their pixels appear in foreignObject
  if (tag === 'CANVAS') {
    const img = origNode.ownerDocument.createElement('img');
    const cs = origWin.getComputedStyle(origNode);
    const rect = origNode.getBoundingClientRect();
    let dataUrl = '';
    try {
      dataUrl = origNode.toDataURL('image/png');
    } catch (_) {
      dataUrl = '';
    }
    if (dataUrl) {
      img.setAttribute('src', dataUrl);
    }
    img.style.cssText = cs.cssText || '';
    img.style.width = `${rect.width || origNode.width}px`;
    img.style.height = `${rect.height || origNode.height}px`;
    img.style.display = cs.display === 'none' ? 'none' : 'block';
    canvasSnapshots.count++;
    return img;
  }

  const clone = origNode.cloneNode(false);
  try {
    const cs = origWin.getComputedStyle(origNode);
    for (let i = 0; i < ANIMATED_STYLE_PROPS.length; i++) {
      const prop = ANIMATED_STYLE_PROPS[i];
      const val = cs[prop];
      if (val !== undefined && val !== '' && val !== 'none' && val !== 'auto') {
        clone.style[prop] = val;
      } else if (prop === 'opacity' || prop === 'transform') {
        clone.style[prop] = val;
      }
    }
    // Freeze CSS animations/transitions in the serialized clone
    clone.style.animation = 'none';
    clone.style.transition = 'none';
  } catch (_) {}

  for (let i = 0; i < origNode.childNodes.length; i++) {
    const childClone = cloneAndBakeNode(origNode.childNodes[i], origWin, canvasSnapshots);
    if (childClone) clone.appendChild(childClone);
  }
  return clone;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

export async function rasterizeDocumentToCanvas(doc, win, targetCanvas, stageWidth, stageHeight) {
  const ctx = targetCanvas.getContext('2d');
  const tw = targetCanvas.width;
  const th = targetCanvas.height;

  // Fill backdrop with document's computed background color (fallback obsidian)
  let bgColor = '#000000';
  try {
    const bodyBg = win.getComputedStyle(doc.body).backgroundColor;
    const htmlBg = win.getComputedStyle(doc.documentElement).backgroundColor;
    if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') bgColor = bodyBg;
    else if (htmlBg && htmlBg !== 'rgba(0, 0, 0, 0)' && htmlBg !== 'transparent') bgColor = htmlBg;
  } catch (_) {}

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, tw, th);

  // Fast vector path if root content is essentially a full-bleed <svg>
  const bodyChildren = doc.body ? Array.from(doc.body.children).filter((el) => el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') : [];
  if (bodyChildren.length === 1 && bodyChildren[0].tagName.toUpperCase() === 'SVG') {
    const svgEl = bodyChildren[0];
    const clonedSvg = cloneAndBakeNode(svgEl, win, { count: 0 });
    clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clonedSvg.getAttribute('viewBox')) {
      const r = svgEl.getBoundingClientRect();
      clonedSvg.setAttribute('viewBox', `0 0 ${r.width || stageWidth} ${r.height || stageHeight}`);
    }
    clonedSvg.setAttribute('width', String(tw));
    clonedSvg.setAttribute('height', String(th));
    const css = collectDocumentCss(doc);
    if (css) {
      const styleEl = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
      styleEl.textContent = css;
      clonedSvg.insertBefore(styleEl, clonedSvg.firstChild);
    }
    const serialized = new XMLSerializer().serializeToString(clonedSvg);
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialized);
    const img = await loadImage(dataUrl);
    ctx.drawImage(img, 0, 0, tw, th);
    return;
  }

  // General HTML + CSS + SVG + Canvas foreignObject rasterization
  const cssText = collectDocumentCss(doc);
  const snapshots = { count: 0 };
  const bakedBody = cloneAndBakeNode(doc.body, win, snapshots);
  bakedBody.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  bakedBody.style.margin = win.getComputedStyle(doc.body).margin || '0';
  bakedBody.style.width = `${stageWidth}px`;
  bakedBody.style.height = `${stageHeight}px`;
  bakedBody.style.overflow = 'hidden';

  const wrapper = doc.createElement('div');
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.style.width = `${stageWidth}px`;
  wrapper.style.height = `${stageHeight}px`;
  wrapper.style.overflow = 'hidden';
  wrapper.style.background = bgColor;

  if (cssText) {
    const styleEl = doc.createElement('style');
    styleEl.textContent = cssText;
    wrapper.appendChild(styleEl);
  }
  wrapper.appendChild(bakedBody);

  const xhtml = new XMLSerializer().serializeToString(wrapper);
  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${stageWidth}" height="${stageHeight}" viewBox="0 0 ${stageWidth} ${stageHeight}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup);

  const img = await loadImage(svgDataUrl);
  // Fit stageWidth x stageHeight cleanly into targetCanvas (tw x th)
  const scale = Math.min(tw / stageWidth, th / stageHeight);
  const dw = stageWidth * scale;
  const dh = stageHeight * scale;
  const dx = (tw - dw) / 2;
  const dy = (th - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}
