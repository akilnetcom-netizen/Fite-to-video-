import { captureIframeFrame } from './frame-capturer.js';
import { replayAudioOffline } from './audio-tracer.js';
import { Mp4Muxer } from './mp4-muxer.js';

const H264_CODECS = [
  'avc1.640028', // High Profile L4.0 (1080p)
  'avc1.4d002a', // Main Profile L4.2
  'avc1.42001f', // Baseline L3.1 (720p)
  'avc1.42E01E'  // Constrained Baseline L3.0
];

export async function probeBrowserCapabilities() {
  const hasSecureContext = Boolean(window.isSecureContext);
  const hasVideoEncoder = typeof window.VideoEncoder === 'function';
  const hasAudioEncoder = typeof window.AudioEncoder === 'function';
  const hasOfflineAudio = typeof (window.OfflineAudioContext || window.webkitOfflineAudioContext) === 'function';
  const hasMediaRecorder = typeof window.MediaRecorder === 'function';
  const testCanvas = document.createElement('canvas');
  const hasCaptureStream = typeof testCanvas.captureStream === 'function';
  const hasGetAnimations = typeof document.getAnimations === 'function';
  const hasAndroidBridge = Boolean(window.AndroidNativeEncoder && typeof window.AndroidNativeEncoder.startSession === 'function');

  let supportedH264 = null;
  if (hasVideoEncoder) {
    for (const codec of H264_CODECS) {
      try {
        const res = await window.VideoEncoder.isConfigSupported({
          codec,
          width: 1280,
          height: 720,
          bitrate: 4_000_000,
          framerate: 30,
          avc: { format: 'avc' }
        });
        if (res && res.supported) {
          supportedH264 = codec;
          break;
        }
      } catch (_) {}
    }
  }

  let supportedAac = null;
  if (hasAudioEncoder) {
    for (const codec of ['mp4a.40.2', 'mp4a.40.5']) {
      try {
        const res = await window.AudioEncoder.isConfigSupported({
          codec,
          numberOfChannels: 2,
          sampleRate: 48000,
          bitrate: 128_000
        });
        if (res && res.supported) {
          supportedAac = codec;
          break;
        }
      } catch (_) {}
    }
  }

  return {
    hasSecureContext,
    hasVideoEncoder,
    hasAudioEncoder,
    hasOfflineAudio,
    hasMediaRecorder,
    hasCaptureStream,
    hasGetAnimations,
    hasAndroidBridge,
    supportedH264,
    supportedAac,
    canFastWebCodecs: Boolean(hasSecureContext && supportedH264),
    canFastNativeBridge: Boolean(hasAndroidBridge),
    canRealtimeFallback: Boolean(hasMediaRecorder && hasCaptureStream)
  };
}

async function encodeAudioBufferWithWebCodecs(audioBuffer, codec, muxer) {
  const sampleRate = audioBuffer.sampleRate;
  const numberOfChannels = Math.min(2, audioBuffer.numberOfChannels);
  const length = audioBuffer.length;

  let encoderError = null;
  const audioEncoder = new window.AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { encoderError = e; }
  });

  audioEncoder.configure({
    codec: codec || 'mp4a.40.2',
    numberOfChannels,
    sampleRate,
    bitrate: 128_000
  });

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;

  const chunkSamples = 1024;
  for (let offset = 0; offset < length; offset += chunkSamples) {
    if (encoderError) throw encoderError;
    const frames = Math.min(chunkSamples, length - offset);
    const planar = new Float32Array(frames * numberOfChannels);
    planar.set(ch0.subarray(offset, offset + frames), 0);
    if (numberOfChannels > 1) {
      planar.set(ch1.subarray(offset, offset + frames), frames);
    }

    const audioData = new window.AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar
    });

    while (audioEncoder.encodeQueueSize > 16) {
      await new Promise((r) => setTimeout(r, 1));
    }
    audioEncoder.encode(audioData);
    audioData.close();
  }

  await audioEncoder.flush();
  audioEncoder.close();
  if (encoderError) throw encoderError;
}

function encodeAudioBufferToWavBase64(audioBuffer) {
  if (!audioBuffer) return '';
  const numCh = Math.min(2, audioBuffer.numberOfChannels);
  const sr = audioBuffer.sampleRate;
  const len = audioBuffer.length;
  const pcmBytes = len * numCh * 2;
  const buf = new ArrayBuffer(44 + pcmBytes);
  const view = new DataView(buf);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcmBytes, true);

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numCh > 1 ? audioBuffer.getChannelData(1) : ch0;
  let offset = 44;
  for (let i = 0; i < len; i++) {
    const s0 = Math.max(-1, Math.min(1, ch0[i]));
    view.setInt16(offset, s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff, true);
    offset += 2;
    if (numCh > 1) {
      const s1 = Math.max(-1, Math.min(1, ch1[i]));
      view.setInt16(offset, s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff, true);
      offset += 2;
    }
  }

  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Runs the deterministic virtual-clock faster-than-real-time rendering pipeline.
 */
export async function runVirtualClockEncode({
  loadFreshIframe,
  width,
  height,
  fps,
  durationSec,
  capabilities,
  onProgress,
  signal
}) {
  const useWebCodecs = capabilities.canFastWebCodecs;
  const useNativeBridge = !useWebCodecs && capabilities.canFastNativeBridge;
  if (!useWebCodecs && !useNativeBridge) {
    throw new Error('NO_FAST_ENCODER');
  }

  onProgress({ phase: 'init', progress: 0.02, frame: 0, totalFrames: Math.ceil(durationSec * fps), speed: 0, etaSec: 0 });

  const iframe = await loadFreshIframe('virtual');
  const win = iframe.contentWindow;
  const vclock = win && win.__VCLOCK__;
  if (!vclock) throw new Error('Virtual clock failed to initialize');

  const totalFrames = Math.max(1, Math.round(durationSec * fps));
  const dtMs = 1000 / fps;
  const frameDurationUs = Math.round(1_000_000 / fps);

  const stageCanvas = document.createElement('canvas');
  stageCanvas.width = width;
  stageCanvas.height = height;

  const bitrate = width >= 1920 ? 8_000_000 : 4_500_000;

  let muxer = null;
  let videoEncoder = null;
  let encoderError = null;
  let nativeSessionId = null;

  if (useWebCodecs) {
    muxer = new Mp4Muxer({
      width,
      height,
      fps,
      hasAudio: Boolean(capabilities.supportedAac),
      sampleRate: 48000,
      channels: 2
    });

    videoEncoder = new window.VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => { encoderError = err; }
    });

    videoEncoder.configure({
      codec: capabilities.supportedH264,
      width,
      height,
      bitrate,
      framerate: fps,
      avc: { format: 'avc' },
      latencyMode: 'quality'
    });
  } else {
    nativeSessionId = window.AndroidNativeEncoder.startSession(width, height, fps, bitrate);
    if (!nativeSessionId) throw new Error('Android native encoder failed to start');
  }

  const startWallMs = performance.now();

  try {
    // Advance initial tiny tick so page setup callbacks run at t=0..1ms
    await vclock.advance(0);

    for (let f = 0; f < totalFrames; f++) {
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (encoderError) throw encoderError;

      await captureIframeFrame(iframe, stageCanvas);

      if (useWebCodecs) {
        const videoFrame = new window.VideoFrame(stageCanvas, {
          timestamp: f * frameDurationUs,
          duration: frameDurationUs
        });
        while (videoEncoder.encodeQueueSize > 8) {
          await new Promise((r) => setTimeout(r, 1));
        }
        const isKey = f === 0 || f % (fps * 2) === 0;
        videoEncoder.encode(videoFrame, { keyFrame: isKey });
        videoFrame.close();
      } else {
        // Send JPEG data URL frame to native Android MediaCodec bridge
        const dataUrl = stageCanvas.toDataURL('image/jpeg', 0.92);
        const comma = dataUrl.indexOf(',');
        const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        window.AndroidNativeEncoder.pushFrame(nativeSessionId, f, b64);
      }

      if (f < totalFrames - 1) {
        await vclock.advance(dtMs);
      }

      // Compute telemetry
      const elapsedWallSec = Math.max(0.001, (performance.now() - startWallMs) / 1000);
      const renderedVideoSec = ((f + 1) / totalFrames) * durationSec;
      const speed = renderedVideoSec / elapsedWallSec;
      const framesLeft = totalFrames - (f + 1);
      const avgSecPerFrame = elapsedWallSec / (f + 1);
      const etaSec = Math.max(0, framesLeft * avgSecPerFrame);

      if (f % 2 === 0 || f === totalFrames - 1) {
        onProgress({
          phase: 'frames',
          progress: 0.05 + 0.80 * ((f + 1) / totalFrames),
          frame: f + 1,
          totalFrames,
          speed,
          etaSec
        });
      }

      // Keep browser UI responsive
      if (f % 4 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');

    // Phase 2: Offline Audio Replay & Mixing
    onProgress({ phase: 'audio', progress: 0.88, frame: totalFrames, totalFrames, speed: 0, etaSec: 1 });
    const audioGraph = vclock.getAudioGraph ? vclock.getAudioGraph() : null;
    const { buffer: audioBuffer, warnings: audioWarnings } = await replayAudioOffline(audioGraph, durationSec, 48000);

    onProgress({ phase: 'mux', progress: 0.94, frame: totalFrames, totalFrames, speed: 0, etaSec: 0 });

    const stageDiag = win.__STAGE_DIAGNOSTICS__ || {};
    const elapsedTotalSec = (performance.now() - startWallMs) / 1000;

    if (useWebCodecs) {
      await videoEncoder.flush();
      videoEncoder.close();
      if (encoderError) throw encoderError;

      if (audioBuffer && capabilities.supportedAac) {
        await encodeAudioBufferWithWebCodecs(audioBuffer, capabilities.supportedAac, muxer);
      }

      const mp4Bytes = muxer.finalize();
      const blob = new Blob([mp4Bytes], { type: 'video/mp4' });
      return {
        blob,
        mimeType: 'video/mp4',
        extension: 'mp4',
        durationSec,
        totalFrames,
        elapsedSec: elapsedTotalSec,
        speedRatio: durationSec / Math.max(0.01, elapsedTotalSec),
        hasAudio: Boolean(audioBuffer && capabilities.supportedAac),
        warnings: audioWarnings,
        diagnostics: stageDiag,
        engineUsed: 'WebCodecs H.264 + AAC (mp4-muxer)'
      };
    } else {
      const wavB64 = audioBuffer ? encodeAudioBufferToWavBase64(audioBuffer) : '';
      const resultPath = window.AndroidNativeEncoder.finishSession(nativeSessionId, wavB64);
      if (!resultPath) throw new Error('Native Android MediaMuxer returned empty output');
      const fileResp = await fetch(`https://htmltomp4.appassets.local/__exports/${encodeURIComponent(resultPath)}`);
      const blob = await fileResp.blob();
      return {
        blob,
        nativeFileName: resultPath,
        mimeType: 'video/mp4',
        extension: 'mp4',
        durationSec,
        totalFrames,
        elapsedSec: elapsedTotalSec,
        speedRatio: durationSec / Math.max(0.01, elapsedTotalSec),
        hasAudio: Boolean(audioBuffer),
        warnings: audioWarnings,
        diagnostics: stageDiag,
        engineUsed: 'Virtual Clock + Android MediaCodec H.264/AAC'
      };
    }
  } catch (err) {
    try {
      if (videoEncoder && videoEncoder.state !== 'closed') videoEncoder.close();
    } catch (_) {}
    try {
      if (nativeSessionId && window.AndroidNativeEncoder) {
        window.AndroidNativeEncoder.cancelSession(nativeSessionId);
      }
    } catch (_) {}
    throw err;
  }
}
