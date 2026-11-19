import { captureIframeFrame } from './frame-capturer.js';

/**
 * Fallback Real-Time Record mode using canvas.captureStream(fps) + MediaRecorder
 * with WebAudio routed via AudioContext.createMediaStreamDestination().
 */
export async function startRealtimeRecord({
  loadFreshIframe,
  width,
  height,
  fps,
  durationSec,
  onProgress,
  onFinished,
  onError
}) {
  if (typeof window.MediaRecorder !== 'function') {
    throw new Error('NO_MEDIA_RECORDER');
  }

  const iframe = await loadFreshIframe('realtime');
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;

  const mirrorCanvas = document.createElement('canvas');
  mirrorCanvas.width = width;
  mirrorCanvas.height = height;

  // Prefer native canvas.captureStream if a viewport canvas exists; otherwise capture mirrorCanvas
  const stageStream = mirrorCanvas.captureStream(fps);
  const tracks = [...stageStream.getVideoTracks()];

  // Attach any WebAudio MediaStreamDestination streams created by the audio tee hook
  const audioStreams = win.__REALTIME_AUDIO_STREAMS__ || [];
  for (const s of audioStreams) {
    s.getAudioTracks().forEach((t) => tracks.push(t));
  }

  // Also capture <audio> or <video> element streams if supported
  const mediaEls = doc ? Array.from(doc.querySelectorAll('audio, video')) : [];
  for (const el of mediaEls) {
    try {
      const cap = el.captureStream ? el.captureStream() : el.mozCaptureStream ? el.mozCaptureStream() : null;
      if (cap) {
        cap.getAudioTracks().forEach((t) => tracks.push(t));
      }
    } catch (_) {}
  }

  const combinedStream = new MediaStream(tracks);

  const mimeCandidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  const chosenMime = mimeCandidates.find((m) => window.MediaRecorder.isTypeSupported(m)) || '';

  const chunks = [];
  const recorder = chosenMime
    ? new window.MediaRecorder(combinedStream, { mimeType: chosenMime, videoBitsPerSecond: width >= 1920 ? 8_000_000 : 4_500_000 })
    : new window.MediaRecorder(combinedStream);

  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  let stopped = false;
  let rafId = 0;
  const startTime = performance.now();

  recorder.onerror = (ev) => {
    stopped = true;
    cancelAnimationFrame(rafId);
    onError(ev.error || new Error('MediaRecorder error'));
  };

  recorder.onstop = () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    combinedStream.getTracks().forEach((t) => t.stop());
    const finalMime = recorder.mimeType || chosenMime || 'video/webm';
    const isMp4 = finalMime.includes('mp4');
    const blob = new Blob(chunks, { type: finalMime });
    const elapsedSec = (performance.now() - startTime) / 1000;
    onFinished({
      blob,
      mimeType: finalMime,
      extension: isMp4 ? 'mp4' : 'webm',
      durationSec: elapsedSec,
      totalFrames: Math.round(elapsedSec * fps),
      elapsedSec,
      speedRatio: 1.0,
      hasAudio: tracks.some((t) => t.kind === 'audio'),
      warnings: isMp4 ? [] : ['Recorded in WebM (browser MediaRecorder does not output native MP4).'],
      engineUsed: `Real-Time MediaRecorder (${finalMime})`
    });
  };

  recorder.start(250);

  let lastDraw = 0;
  const intervalMs = 1000 / fps;

  async function pump(now) {
    if (stopped) return;
    if (now - lastDraw >= intervalMs * 0.85) {
      lastDraw = now;
      try {
        await captureIframeFrame(iframe, mirrorCanvas);
      } catch (_) {}
    }

    const elapsedSec = (now - startTime) / 1000;
    const pct = Math.min(0.99, elapsedSec / Math.max(0.5, durationSec));
    onProgress({
      phase: 'realtime',
      progress: pct,
      frame: Math.round(elapsedSec * fps),
      totalFrames: Math.round(durationSec * fps),
      speed: 1.0,
      etaSec: Math.max(0, durationSec - elapsedSec)
    });

    if (elapsedSec >= durationSec) {
      if (recorder.state === 'recording') recorder.stop();
      return;
    }
    rafId = requestAnimationFrame(pump);
  }

  rafId = requestAnimationFrame(pump);

  return {
    stop() {
      if (!stopped && recorder.state === 'recording') {
        recorder.stop();
      }
    }
  };
}
