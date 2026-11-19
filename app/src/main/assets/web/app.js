import { createTranslator } from './engine/i18n.js';
import { buildVirtualClockScript, injectScriptIntoHtml } from './engine/virtual-clock.js';
import { detectAnimationDuration } from './engine/duration-detector.js';
import { probeBrowserCapabilities, runVirtualClockEncode } from './engine/encoder.js';
import { startRealtimeRecord } from './engine/realtime-recorder.js';
import { SAMPLES } from './engine/samples.js';

const state = {
  lang: 'en',
  rawHtml: '',
  filename: 'animation.html',
  resolution: '720p',
  aspect: '16:9',
  fps: 30,
  durationSec: 5.0,
  durationSource: '',
  mode: 'virtual', // 'virtual' | 'realtime'
  capabilities: null,
  busy: false,
  abortController: null,
  realtimeHandle: null,
  lastOutputBlob: null,
  lastOutputUrl: null,
  lastOutputName: 'animation.mp4',
  lastNativeFileName: null
};

const t = createTranslator(() => state.lang);

const els = {
  supportDot: document.getElementById('supportDot'),
  supportTitle: document.getElementById('supportTitle'),
  supportMessage: document.getElementById('supportMessage'),
  capabilityPills: document.getElementById('capabilityPills'),
  langBtn: document.getElementById('langBtn'),
  alertBox: document.getElementById('alertBox'),
  alertText: document.getElementById('alertText'),
  uploadTitle: document.getElementById('uploadTitle'),
  uploadHint: document.getElementById('uploadHint'),
  loadedFileBadge: document.getElementById('loadedFileBadge'),
  dropZone: document.getElementById('dropZone'),
  fileInput: document.getElementById('fileInput'),
  pickFileBtn: document.getElementById('pickFileBtn'),
  samplesLabel: document.getElementById('samplesLabel'),
  sampleCanvasBtn: document.getElementById('sampleCanvasBtn'),
  sampleCssBtn: document.getElementById('sampleCssBtn'),
  sampleSvgBtn: document.getElementById('sampleSvgBtn'),
  stagePreviewTitle: document.getElementById('stagePreviewTitle'),
  stageStatusChip: document.getElementById('stageStatusChip'),
  stageWrapper: document.getElementById('stageWrapper'),
  stageEmpty: document.getElementById('stageEmpty'),
  noFileLoadedText: document.getElementById('noFileLoadedText'),
  stageFrame: document.getElementById('stageFrame'),
  settingsTitle: document.getElementById('settingsTitle'),
  resolutionLabel: document.getElementById('resolutionLabel'),
  aspectLabel: document.getElementById('aspectLabel'),
  fpsLabel: document.getElementById('fpsLabel'),
  durationLabel: document.getElementById('durationLabel'),
  durationInput: document.getElementById('durationInput'),
  detectBtn: document.getElementById('detectBtn'),
  durationSourceText: document.getElementById('durationSourceText'),
  modeFastBtn: document.getElementById('modeFastBtn'),
  modeRealtimeBtn: document.getElementById('modeRealtimeBtn'),
  convertBtn: document.getElementById('convertBtn'),
  stopBtn: document.getElementById('stopBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  progressBox: document.getElementById('progressBox'),
  phaseText: document.getElementById('phaseText'),
  percentText: document.getElementById('percentText'),
  progressFill: document.getElementById('progressFill'),
  frameStat: document.getElementById('frameStat'),
  speedStat: document.getElementById('speedStat'),
  etaStat: document.getElementById('etaStat'),
  outputCard: document.getElementById('outputCard'),
  previewTitle: document.getElementById('previewTitle'),
  outputMetaBadge: document.getElementById('outputMetaBadge'),
  outputVideo: document.getElementById('outputVideo'),
  outputEngineText: document.getElementById('outputEngineText'),
  downloadLink: document.getElementById('downloadLink'),
  shareAndroidBtn: document.getElementById('shareAndroidBtn')
};

function showAlert(msg, isError = false) {
  if (!msg) {
    els.alertBox.classList.add('hidden');
    return;
  }
  els.alertBox.classList.remove('hidden');
  els.alertBox.classList.toggle('error', isError);
  els.alertText.textContent = msg;
}

function getTargetDimensions() {
  const shortSide = state.resolution === '1080p' ? 1080 : 720;
  const longSide = state.resolution === '1080p' ? 1920 : 1280;
  if (state.aspect === '9:16') return { width: shortSide, height: longSide };
  if (state.aspect === '1:1') return { width: shortSide, height: shortSide };
  return { width: longSide, height: shortSide };
}

function getLogicalStageSize() {
  if (state.aspect === '9:16') return { width: 720, height: 1280 };
  if (state.aspect === '1:1') return { width: 720, height: 720 };
  return { width: 1280, height: 720 };
}

function layoutStageFrame() {
  const { width, height } = getLogicalStageSize();
  const rect = els.stageWrapper.getBoundingClientRect();
  const availW = rect.width || 320;
  const scale = availW / width;
  els.stageFrame.style.width = `${width}px`;
  els.stageFrame.style.height = `${height}px`;
  els.stageFrame.style.transform = `scale(${scale})`;
}

function updateStageAspectClass() {
  els.stageWrapper.classList.remove('ratio-16-9', 'ratio-9-16', 'ratio-1-1');
  if (state.aspect === '9:16') els.stageWrapper.classList.add('ratio-9-16');
  else if (state.aspect === '1:1') els.stageWrapper.classList.add('ratio-1-1');
  else els.stageWrapper.classList.add('ratio-16-9');
  layoutStageFrame();
}

function applyTranslations() {
  els.supportTitle.textContent = t('supportTitle');
  els.uploadTitle.textContent = t('uploadTitle');
  els.uploadHint.textContent = t('uploadHint');
  els.pickFileBtn.textContent = t('pickFileBtn');
  els.samplesLabel.textContent = t('samplesLabel');
  els.sampleCanvasBtn.textContent = t('sampleCanvas');
  els.sampleCssBtn.textContent = t('sampleCss');
  els.sampleSvgBtn.textContent = t('sampleSvg');
  els.stagePreviewTitle.textContent = t('stagePreviewTitle');
  els.noFileLoadedText.textContent = t('noFileLoaded');
  els.settingsTitle.textContent = t('settingsTitle');
  els.resolutionLabel.textContent = t('resolutionLabel');
  els.aspectLabel.textContent = t('aspectLabel');
  els.fpsLabel.textContent = t('fpsLabel');
  els.durationLabel.textContent = t('durationLabel');
  els.detectBtn.textContent = t('detectBtn');
  els.modeFastBtn.textContent = t('modeFast');
  els.modeRealtimeBtn.textContent = t('modeRealtime');
  els.convertBtn.textContent = state.mode === 'virtual' ? t('startFastBtn') : t('startRealtimeBtn');
  els.stopBtn.textContent = t('stopRealtimeBtn');
  els.cancelBtn.textContent = t('cancelBtn');
  els.previewTitle.textContent = t('previewTitle');
  els.downloadLink.textContent = window.AndroidFileBridge ? t('saveAndroidBtn') : t('downloadBtn');
  els.shareAndroidBtn.textContent = t('shareAndroidBtn');
  renderSupportBanner();
  if (state.durationSource) {
    els.durationSourceText.textContent = `${t('detectedFrom')}: ${state.durationSource}. ${t('manualOverrideHint')}`;
  }
}

function renderSupportBanner() {
  const cap = state.capabilities;
  if (!cap) return;

  const pills = [
    { label: 'SecureContext', ok: cap.hasSecureContext },
    { label: cap.supportedH264 ? `H.264 (${cap.supportedH264})` : 'WebCodecs H.264', ok: Boolean(cap.supportedH264) },
    { label: cap.supportedAac ? 'AAC' : 'WebCodecs AAC', ok: Boolean(cap.supportedAac) },
    { label: 'OfflineAudio', ok: cap.hasOfflineAudio },
    { label: 'MediaRecorder', ok: cap.canRealtimeFallback },
    { label: 'getAnimations', ok: cap.hasGetAnimations }
  ];
  if (cap.hasAndroidBridge) {
    pills.push({ label: 'Android MediaCodec', ok: true });
  }

  els.capabilityPills.innerHTML = '';
  pills.forEach((p) => {
    const span = document.createElement('span');
    span.className = `cap-pill ${p.ok ? 'ok' : 'no'}`;
    span.textContent = `${p.ok ? '✓' : '✕'} ${p.label}`;
    els.capabilityPills.appendChild(span);
  });

  els.supportDot.classList.remove('warn', 'err');
  if (cap.canFastWebCodecs) {
    els.supportMessage.textContent = t('supportAllGood');
  } else if (cap.canFastNativeBridge) {
    els.supportDot.classList.add('warn');
    els.supportMessage.textContent = t('supportNativeFallback');
  } else if (cap.canRealtimeFallback) {
    els.supportDot.classList.add('warn');
    els.supportMessage.textContent = `${t('supportLimited')} ${!cap.hasSecureContext ? t('errSecureContext') : t('errNoVideoEncoder')}`;
  } else {
    els.supportDot.classList.add('err');
    els.supportMessage.textContent = `${t('errNoVideoEncoder')} ${t('errNoMediaRecorder')}`;
  }
}

function loadFreshIframe(mode = 'virtual') {
  return new Promise((resolve, reject) => {
    if (!state.rawHtml) {
      reject(new Error('No HTML loaded'));
      return;
    }
    const frame = els.stageFrame;
    frame.classList.remove('hidden');
    els.stageEmpty.classList.add('hidden');
    layoutStageFrame();

    const preScript = buildVirtualClockScript({ mode });
    const injectedHtml = injectScriptIntoHtml(state.rawHtml, preScript);

    const onLoad = () => {
      frame.removeEventListener('load', onLoad);
      resolve(frame);
    };
    frame.addEventListener('load', onLoad);
    frame.srcdoc = injectedHtml;
  });
}

function validateHtmlPayload(filename, text) {
  const lower = (filename || '').toLowerCase();
  if (lower && !lower.endsWith('.html') && !lower.endsWith('.htm')) {
    return { valid: false, error: t('errUnknownFile') };
  }
  if (!text || !text.trim()) {
    return { valid: false, error: t('errEmptyHtml') };
  }
  // Check for binary NUL bytes or non-HTML payloads (e.g., PNG/ZIP/PDF renamed to .html)
  if (text.includes('\u0000')) {
    return { valid: false, error: t('errUnknownFile') };
  }
  const trimmed = text.trimStart();
  const looksLikeHtml = /<(?:!doctype|html|head|body|canvas|svg|div|script|style|p|h1)\b/i.test(trimmed);
  if (!looksLikeHtml) {
    return { valid: false, error: t('errUnknownFile') };
  }
  return { valid: true };
}

async function handleLoadHtml(filename, text) {
  const check = validateHtmlPayload(filename, text);
  if (!check.valid) {
    showAlert(check.error, true);
    return;
  }

  showAlert('');
  state.filename = filename || 'animation.html';
  state.rawHtml = text;
  els.loadedFileBadge.textContent = state.filename;
  els.loadedFileBadge.classList.remove('hidden');
  els.convertBtn.disabled = false;
  els.stageStatusChip.textContent = t('readyStatus');

  await runAutoDetectDuration();
  // Show live preview in realtime mode in the stage so the user sees the loaded animation immediately
  await loadFreshIframe('realtime');
}

async function runAutoDetectDuration() {
  if (!state.rawHtml) return;
  els.detectBtn.disabled = true;
  els.stageStatusChip.textContent = t('detecting');
  els.durationSourceText.textContent = t('detecting');

  try {
    const res = await detectAnimationDuration({
      loadFreshIframe,
      fps: state.fps,
      onProgress: (sec) => {
        els.durationSourceText.textContent = `${t('detecting')} (${sec.toFixed(1)}s)`;
      }
    });
    state.durationSec = res.durationSec;
    state.durationSource = res.source;
    els.durationInput.value = String(res.durationSec);
    els.durationSourceText.textContent = `${t('detectedFrom')}: ${res.source}. ${t('manualOverrideHint')}`;

    const iframeDiag = els.stageFrame.contentWindow && els.stageFrame.contentWindow.__STAGE_DIAGNOSTICS__;
    if (iframeDiag && iframeDiag.webglDetected) {
      showAlert(t('warnWebglDetected'), false);
    } else if (iframeDiag && iframeDiag.externalMediaDetected) {
      showAlert(t('warnExternalMedia'), false);
    }
  } catch (err) {
    state.durationSec = 5.0;
    state.durationSource = 'Default';
    els.durationInput.value = '5.0';
    els.durationSourceText.textContent = `${t('manualOverrideHint')}`;
  } finally {
    els.detectBtn.disabled = false;
    els.stageStatusChip.textContent = t('readyStatus');
  }
}

function formatEta(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  const s = Math.ceil(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}

let lastNotifPct = -1;

function setHostKeepAwake(active) {
  if (window.AndroidHost && typeof window.AndroidHost.setKeepAwake === 'function') {
    window.AndroidHost.setKeepAwake(Boolean(active));
  }
}

function updateProgressUI({ phase, progress, frame, totalFrames, speed, etaSec }) {
  const phaseMap = {
    init: t('phaseInit'),
    frames: t('phaseFrames'),
    audio: t('phaseAudio'),
    mux: t('phaseMux'),
    realtime: t('phaseRealtime')
  };
  const phaseLabel = phaseMap[phase] || phase;
  els.phaseText.textContent = phaseLabel;
  const pct = Math.max(0, Math.min(100, Math.round((progress || 0) * 100)));
  els.percentText.textContent = `${pct}%`;
  els.progressFill.style.width = `${pct}%`;
  els.frameStat.textContent = `${t('frameLabel')}: ${frame}/${totalFrames}`;
  els.speedStat.textContent = `${t('speedLabel')}: ${speed > 0 ? speed.toFixed(2) : '--'}x`;
  els.etaStat.textContent = `${t('etaLabel')}: ${formatEta(etaSec)}`;

  if (window.AndroidHost && typeof window.AndroidHost.updateRenderProgress === 'function') {
    if (pct === 100 || pct - lastNotifPct >= 4 || pct < lastNotifPct) {
      lastNotifPct = pct;
      const detail = `${t('frameLabel')} ${frame}/${totalFrames} • ${speed > 0 ? speed.toFixed(1) + 'x • ' : ''}${t('etaLabel')}: ${formatEta(etaSec)}`;
      window.AndroidHost.updateRenderProgress(pct, `${phaseLabel} (${pct}%)`, detail);
    }
  }
}

async function presentOutput(result) {
  if (state.lastOutputUrl) {
    URL.revokeObjectURL(state.lastOutputUrl);
  }
  state.lastOutputBlob = result.blob;
  state.lastOutputUrl = URL.createObjectURL(result.blob);
  const baseName = (state.filename || 'animation').replace(/\.html?$/i, '');
  state.lastOutputName = `${baseName}.${result.extension || 'mp4'}`;
  state.lastNativeFileName = result.nativeFileName || null;

  els.outputCard.classList.remove('hidden');
  els.outputVideo.src = state.lastOutputUrl;
  els.downloadLink.href = state.lastOutputUrl;
  els.downloadLink.download = state.lastOutputName;

  const sizeMb = (result.blob.size / (1024 * 1024)).toFixed(2);
  els.outputMetaBadge.textContent = `${sizeMb} MB • ${result.durationSec.toFixed(1)}s`;
  els.outputEngineText.textContent = `${result.engineUsed} • ${result.speedRatio.toFixed(2)}x (${result.elapsedSec.toFixed(1)}s)`;

  if (window.AndroidFileBridge) {
    els.shareAndroidBtn.classList.remove('hidden');
    // Auto-save to Android Downloads/HTMLtoMP4 without relying on a[download]
    try {
      if (state.lastNativeFileName && typeof window.AndroidFileBridge.autoSaveExistingExport === 'function') {
        window.AndroidFileBridge.autoSaveExistingExport(state.lastNativeFileName, state.lastOutputName);
      } else if (typeof window.AndroidFileBridge.autoSaveBlobBase64 === 'function') {
        const b64 = await blobToBase64(result.blob);
        window.AndroidFileBridge.autoSaveBlobBase64(state.lastOutputName, result.blob.type || 'video/mp4', b64);
      }
    } catch (_) {}
  }

  if (result.warnings && result.warnings.length > 0) {
    showAlert(result.warnings.join(' | '), false);
  }
  els.stageStatusChip.textContent = t('doneStatus');

  if (window.AndroidHost && typeof window.AndroidHost.onExportReady === 'function') {
    window.AndroidHost.onExportReady(state.lastOutputName, sizeMb, result.engineUsed);
  }
}

async function startConversion() {
  if (!state.rawHtml || state.busy) return;
  const dur = Math.max(0.5, Math.min(300, Number(els.durationInput.value) || state.durationSec || 5));
  state.durationSec = dur;
  const { width, height } = getTargetDimensions();

  state.busy = true;
  lastNotifPct = -1;
  setHostKeepAwake(true);
  showAlert('');
  els.progressBox.classList.remove('hidden');
  els.outputCard.classList.add('hidden');
  els.convertBtn.classList.add('hidden');

  if (state.mode === 'virtual') {
    els.cancelBtn.classList.remove('hidden');
    state.abortController = new AbortController();
    try {
      const result = await runVirtualClockEncode({
        loadFreshIframe,
        width,
        height,
        fps: state.fps,
        durationSec: dur,
        capabilities: state.capabilities,
        onProgress: updateProgressUI,
        signal: state.abortController.signal
      });
      await presentOutput(result);
    } catch (err) {
      if (window.AndroidHost && typeof window.AndroidHost.clearRenderNotification === 'function') {
        window.AndroidHost.clearRenderNotification();
      }
      if (err && err.name === 'AbortError') {
        showAlert(t('cancelBtn'), false);
      } else {
        showAlert(`${t('errVirtualFailed')} (${err.message || err})`, true);
        setMode('realtime');
      }
    } finally {
      state.busy = false;
      state.abortController = null;
      setHostKeepAwake(false);
      els.cancelBtn.classList.add('hidden');
      els.convertBtn.classList.remove('hidden');
      await loadFreshIframe('realtime');
    }
  } else {
    els.stopBtn.classList.remove('hidden');
    try {
      state.realtimeHandle = await startRealtimeRecord({
        loadFreshIframe,
        width,
        height,
        fps: state.fps,
        durationSec: dur,
        onProgress: updateProgressUI,
        onFinished: async (res) => {
          state.busy = false;
          state.realtimeHandle = null;
          setHostKeepAwake(false);
          els.stopBtn.classList.add('hidden');
          els.convertBtn.classList.remove('hidden');
          await presentOutput(res);
        },
        onError: (err) => {
          state.busy = false;
          state.realtimeHandle = null;
          setHostKeepAwake(false);
          if (window.AndroidHost && typeof window.AndroidHost.clearRenderNotification === 'function') {
            window.AndroidHost.clearRenderNotification();
          }
          els.stopBtn.classList.add('hidden');
          els.convertBtn.classList.remove('hidden');
          showAlert(String(err.message || err), true);
        }
      });
    } catch (err) {
      state.busy = false;
      setHostKeepAwake(false);
      if (window.AndroidHost && typeof window.AndroidHost.clearRenderNotification === 'function') {
        window.AndroidHost.clearRenderNotification();
      }
      els.stopBtn.classList.add('hidden');
      els.convertBtn.classList.remove('hidden');
      showAlert(err.message === 'NO_MEDIA_RECORDER' ? t('errNoMediaRecorder') : String(err.message || err), true);
    }
  }
}

function setMode(mode) {
  state.mode = mode;
  els.modeFastBtn.classList.toggle('active', mode === 'virtual');
  els.modeRealtimeBtn.classList.toggle('active', mode === 'realtime');
  els.convertBtn.textContent = mode === 'virtual' ? t('startFastBtn') : t('startRealtimeBtn');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || '');
      const idx = res.indexOf(',');
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function setupEventListeners() {
  els.langBtn.addEventListener('click', () => {
    state.lang = state.lang === 'en' ? 'bn' : 'en';
    applyTranslations();
  });

  els.pickFileBtn.addEventListener('click', () => {
    if (window.AndroidHost && typeof window.AndroidHost.openHtmlPicker === 'function') {
      window.AndroidHost.openHtmlPicker();
    } else {
      els.fileInput.click();
    }
  });

  els.fileInput.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      await handleLoadHtml(file.name, text);
    } catch (_) {
      showAlert(t('errUnknownFile'), true);
    }
    els.fileInput.value = '';
  });

  els.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropZone.classList.add('dragover');
  });
  els.dropZone.addEventListener('dragleave', () => {
    els.dropZone.classList.remove('dragover');
  });
  els.dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const text = await file.text();
    await handleLoadHtml(file.name, text);
  });

  document.querySelectorAll('.sample-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sample;
      const sample = SAMPLES[key];
      if (sample) handleLoadHtml(sample.filename, sample.html);
    });
  });

  document.querySelectorAll('[data-res]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-res]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.resolution = btn.dataset.res;
    });
  });

  document.querySelectorAll('[data-aspect]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-aspect]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.aspect = btn.dataset.aspect;
      updateStageAspectClass();
    });
  });

  document.querySelectorAll('[data-fps]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-fps]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.fps = Number(btn.dataset.fps) || 30;
    });
  });

  els.detectBtn.addEventListener('click', runAutoDetectDuration);
  els.modeFastBtn.addEventListener('click', () => setMode('virtual'));
  els.modeRealtimeBtn.addEventListener('click', () => setMode('realtime'));
  els.convertBtn.addEventListener('click', startConversion);

  els.cancelBtn.addEventListener('click', () => {
    if (state.abortController) state.abortController.abort();
  });
  els.stopBtn.addEventListener('click', () => {
    if (state.realtimeHandle) state.realtimeHandle.stop();
  });

  els.downloadLink.addEventListener('click', async (ev) => {
    if (window.AndroidFileBridge && state.lastOutputBlob) {
      ev.preventDefault();
      if (state.lastNativeFileName && typeof window.AndroidFileBridge.saveExistingExport === 'function') {
        window.AndroidFileBridge.saveExistingExport(state.lastNativeFileName, state.lastOutputName);
      } else {
        const b64 = await blobToBase64(state.lastOutputBlob);
        window.AndroidFileBridge.saveBlobBase64(state.lastOutputName, state.lastOutputBlob.type || 'video/mp4', b64);
      }
    }
  });

  els.shareAndroidBtn.addEventListener('click', async () => {
    if (!window.AndroidFileBridge || !state.lastOutputBlob) return;
    if (state.lastNativeFileName && typeof window.AndroidFileBridge.shareExistingExport === 'function') {
      window.AndroidFileBridge.shareExistingExport(state.lastNativeFileName, state.lastOutputName);
    } else {
      const b64 = await blobToBase64(state.lastOutputBlob);
      window.AndroidFileBridge.shareBlobBase64(state.lastOutputName, state.lastOutputBlob.type || 'video/mp4', b64);
    }
  });
}

// Expose bridge hooks for native Android Compose controls
window.loadHtmlFromHost = (filename, htmlContent) => handleLoadHtml(filename, htmlContent);
window.setAppLanguage = (lang) => {
  state.lang = lang === 'bn' ? 'bn' : 'en';
  applyTranslations();
};
window.triggerSample = (key) => {
  const sample = SAMPLES[key];
  if (sample) handleLoadHtml(sample.filename, sample.html);
};
window.showHostError = (enMsg, bnMsg) => {
  showAlert(state.lang === 'bn' ? (bnMsg || enMsg) : enMsg, true);
};

async function init() {
  setupEventListeners();
  updateStageAspectClass();
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => layoutStageFrame()).observe(els.stageWrapper);
  } else {
    window.addEventListener('resize', layoutStageFrame);
  }
  state.capabilities = await probeBrowserCapabilities();
  if (!state.capabilities.canFastWebCodecs && !state.capabilities.canFastNativeBridge && state.capabilities.canRealtimeFallback) {
    setMode('realtime');
  }
  applyTranslations();
}

init();
