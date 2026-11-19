/**
 * Generates the WebAudio + HTMLMediaElement wrapper script injected into the iframe
 * BEFORE page scripts run, plus the host-side OfflineAudioContext replay engine.
 */
export function buildAudioHookSource(mode) {
  return `
(function() {
  const AUDIO_MODE = ${JSON.stringify(mode)};
  const NativeAudioCtx = window.AudioContext || window.webkitAudioContext;
  const NativeOfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  if (AUDIO_MODE === 'realtime') {
    // In real-time record mode, tee all connections to ctx.destination into a MediaStreamDestination
    window.__REALTIME_AUDIO_STREAMS__ = [];
    if (NativeAudioCtx) {
      const origConnect = AudioNode.prototype.connect;
      const destMap = new WeakMap();
      function getTee(ctx) {
        if (!destMap.has(ctx) && typeof ctx.createMediaStreamDestination === 'function') {
          const msd = ctx.createMediaStreamDestination();
          destMap.set(ctx, msd);
          window.__REALTIME_AUDIO_STREAMS__.push(msd.stream);
        }
        return destMap.get(ctx);
      }
      AudioNode.prototype.connect = function(target) {
        const res = origConnect.apply(this, arguments);
        try {
          if (target && this.context && target === this.context.destination) {
            const tee = getTee(this.context);
            if (tee) origConnect.call(this, tee);
          }
        } catch (_) {}
        return res;
      };
    }
    return;
  }

  // VIRTUAL MODE: Trace all WebAudio nodes, buffers, parameter automations & media elements
  const getVirtualSec = function() {
    return window.__VCLOCK__ ? (window.__VCLOCK__.now() / 1000) : 0;
  };

  let nextNodeId = 1;
  const nodes = [];
  const connections = [];
  const buffers = [];
  const periodicWaves = [];
  const mediaEvents = [];
  let maxEndSec = 0;

  function bumpEnd(t) {
    if (Number.isFinite(t) && t > maxEndSec && t < 3600) {
      maxEndSec = t;
    }
  }

  function makeParam(nodeRec, name, defaultValue) {
    const events = [];
    let currentVal = defaultValue;
    return {
      get value() { return currentVal; },
      set value(v) {
        const num = Number(v);
        if (Number.isFinite(num)) {
          currentVal = num;
          const t = getVirtualSec();
          events.push({ op: 'setValueAtTime', value: num, time: t });
        }
      },
      get defaultValue() { return defaultValue; },
      setValueAtTime: function(value, startTime) {
        const t = Math.max(0, Number(startTime) || 0);
        currentVal = Number(value);
        events.push({ op: 'setValueAtTime', value: Number(value), time: t });
        bumpEnd(t);
        return this;
      },
      linearRampToValueAtTime: function(value, endTime) {
        const t = Math.max(0, Number(endTime) || 0);
        currentVal = Number(value);
        events.push({ op: 'linearRampToValueAtTime', value: Number(value), time: t });
        bumpEnd(t);
        return this;
      },
      exponentialRampToValueAtTime: function(value, endTime) {
        const t = Math.max(0, Number(endTime) || 0);
        currentVal = Number(value);
        events.push({ op: 'exponentialRampToValueAtTime', value: Number(value), time: t });
        bumpEnd(t);
        return this;
      },
      setTargetAtTime: function(target, startTime, timeConstant) {
        const t = Math.max(0, Number(startTime) || 0);
        events.push({ op: 'setTargetAtTime', target: Number(target), time: t, timeConstant: Number(timeConstant) || 0.01 });
        bumpEnd(t + (Number(timeConstant) || 0.01) * 4);
        return this;
      },
      setValueCurveAtTime: function(values, startTime, duration) {
        const t = Math.max(0, Number(startTime) || 0);
        const dur = Math.max(0.001, Number(duration) || 0.001);
        events.push({ op: 'setValueCurveAtTime', values: Array.from(values), time: t, duration: dur });
        bumpEnd(t + dur);
        return this;
      },
      cancelScheduledValues: function(cancelTime) {
        events.push({ op: 'cancelScheduledValues', time: Math.max(0, Number(cancelTime) || 0) });
        return this;
      },
      cancelAndHoldAtTime: function(cancelTime) {
        events.push({ op: 'cancelAndHoldAtTime', time: Math.max(0, Number(cancelTime) || 0) });
        return this;
      },
      __export: function() { return { name: name, initial: defaultValue, events: events }; }
    };
  }

  function createNode(ctx, kind, props, paramSpecs) {
    const id = nextNodeId++;
    const rec = {
      id: id,
      kind: kind,
      props: Object.assign({}, props || {}),
      params: {},
      starts: [],
      stops: [],
      bufferId: null,
      periodicWaveId: null,
      mediaRefId: null
    };
    const node = {
      __nodeId: id,
      context: ctx,
      numberOfInputs: kind === 'oscillator' || kind === 'bufferSource' || kind === 'constantSource' ? 0 : 1,
      numberOfOutputs: kind === 'destination' ? 0 : 1,
      connect: function(dest, outIdx, inIdx) {
        if (dest && dest.__nodeId) {
          connections.push({ from: id, to: dest.__nodeId, outIdx: outIdx || 0, inIdx: inIdx || 0 });
        }
        return dest;
      },
      disconnect: function(dest) {
        if (!dest) {
          for (let i = connections.length - 1; i >= 0; i--) {
            if (connections[i].from === id) connections.splice(i, 1);
          }
        } else if (dest.__nodeId) {
          for (let i = connections.length - 1; i >= 0; i--) {
            if (connections[i].from === id && connections[i].to === dest.__nodeId) connections.splice(i, 1);
          }
        }
      }
    };

    if (paramSpecs) {
      Object.keys(paramSpecs).forEach(function(k) {
        const p = makeParam(rec, k, paramSpecs[k]);
        rec.params[k] = p;
        node[k] = p;
      });
    }
    nodes.push(rec);
    return { node: node, rec: rec };
  }

  function FakeAudioBuffer(options) {
    this.numberOfChannels = options.numberOfChannels || 2;
    this.length = options.length || 1;
    this.sampleRate = options.sampleRate || 48000;
    this.duration = this.length / this.sampleRate;
    this._channels = [];
    for (let c = 0; c < this.numberOfChannels; c++) {
      this._channels.push(new Float32Array(this.length));
    }
    this.__bufferId = buffers.length + 1;
    buffers.push(this);
  }
  FakeAudioBuffer.prototype.getChannelData = function(c) {
    return this._channels[c] || this._channels[0];
  };
  FakeAudioBuffer.prototype.copyFromChannel = function(dest, c, start) {
    const src = this.getChannelData(c);
    dest.set(src.subarray(start || 0, (start || 0) + dest.length));
  };
  FakeAudioBuffer.prototype.copyToChannel = function(src, c, start) {
    const dst = this.getChannelData(c);
    dst.set(src, start || 0);
  };

  function FakeAudioContext(opts) {
    const sr = (opts && opts.sampleRate) || 48000;
    this.sampleRate = sr;
    this.state = 'running';
    this.baseLatency = 0;
    this.outputLatency = 0;
    this.onstatechange = null;
    const destPair = createNode(this, 'destination', {}, null);
    this.destination = destPair.node;
    this.destination.maxChannelCount = 2;
    this.listener = {
      positionX: makeParam(destPair.rec, 'posX', 0),
      positionY: makeParam(destPair.rec, 'posY', 0),
      positionZ: makeParam(destPair.rec, 'posZ', 0),
      setPosition: function() {},
      setOrientation: function() {}
    };
  }
  Object.defineProperty(FakeAudioContext.prototype, 'currentTime', {
    get: function() { return getVirtualSec(); }
  });
  FakeAudioContext.prototype.resume = function() { this.state = 'running'; return Promise.resolve(); };
  FakeAudioContext.prototype.suspend = function() { this.state = 'suspended'; return Promise.resolve(); };
  FakeAudioContext.prototype.close = function() { this.state = 'closed'; return Promise.resolve(); };
  FakeAudioContext.prototype.createBuffer = function(channels, length, sampleRate) {
    return new FakeAudioBuffer({ numberOfChannels: channels, length: length, sampleRate: sampleRate });
  };
  FakeAudioContext.prototype.decodeAudioData = function(arrayBuffer, ok, err) {
    const p = (NativeOfflineCtx ? new NativeOfflineCtx(2, 1, this.sampleRate).decodeAudioData(arrayBuffer) : Promise.reject(new Error('No OfflineAudioContext')))
      .then(function(decoded) {
        const fb = new FakeAudioBuffer({
          numberOfChannels: decoded.numberOfChannels,
          length: decoded.length,
          sampleRate: decoded.sampleRate
        });
        for (let c = 0; c < decoded.numberOfChannels; c++) {
          fb.getChannelData(c).set(decoded.getChannelData(c));
        }
        if (ok) ok(fb);
        return fb;
      }, function(e) {
        if (err) err(e);
        throw e;
      });
    return p;
  };
  FakeAudioContext.prototype.createGain = function() {
    return createNode(this, 'gain', {}, { gain: 1 }).node;
  };
  FakeAudioContext.prototype.createOscillator = function() {
    const pair = createNode(this, 'oscillator', { type: 'sine' }, { frequency: 440, detune: 0 });
    const n = pair.node;
    Object.defineProperty(n, 'type', {
      get: function() { return pair.rec.props.type; },
      set: function(v) { pair.rec.props.type = v; }
    });
    n.setPeriodicWave = function(pw) { if (pw && pw.__pwId) pair.rec.periodicWaveId = pw.__pwId; };
    n.start = function(when) {
      const t = when === undefined ? getVirtualSec() : Math.max(0, Number(when) || 0);
      pair.rec.starts.push({ when: t });
      bumpEnd(t + 0.5);
    };
    n.stop = function(when) {
      const t = when === undefined ? getVirtualSec() : Math.max(0, Number(when) || 0);
      pair.rec.stops.push({ when: t });
      bumpEnd(t);
    };
    return n;
  };
  FakeAudioContext.prototype.createConstantSource = function() {
    const pair = createNode(this, 'constantSource', {}, { offset: 1 });
    const n = pair.node;
    n.start = function(when) {
      const t = when === undefined ? getVirtualSec() : Math.max(0, Number(when) || 0);
      pair.rec.starts.push({ when: t });
    };
    n.stop = function(when) {
      const t = when === undefined ? getVirtualSec() : Math.max(0, Number(when) || 0);
      pair.rec.stops.push({ when: t });
      bumpEnd(t);
    };
    return n;
  };
  FakeAudioContext.prototype.createBufferSource = function() {
    const pair = createNode(this, 'bufferSource', { loop: false, loopStart: 0, loopEnd: 0 }, { playbackRate: 1, detune: 0 });
    const n = pair.node;
    let bufRef = null;
    Object.defineProperty(n, 'buffer', {
      get: function() { return bufRef; },
      set: function(b) {
        bufRef = b;
        pair.rec.bufferId = b && b.__bufferId ? b.__bufferId : null;
      }
    });
    ['loop', 'loopStart', 'loopEnd'].forEach(function(prop) {
      Object.defineProperty(n, prop, {
        get: function() { return pair.rec.props[prop]; },
        set: function(v) { pair.rec.props[prop] = v; }
      });
    });
    n.start = function(when, offset, duration) {
      const t = when === undefined ? getVirtualSec() : Math.max(0, Number(when) || 0);
      pair.rec.starts.push({ when: t, offset: offset || 0, duration: duration });
      const bufDur = bufRef ? bufRef.duration : 0.5;
      if (duration !== undefined) bumpEnd(t + Number(duration));
      else if (!pair.rec.props.loop) bumpEnd(t + bufDur);
    };
    n.stop = function(when) {
      const t = when === undefined ? getVirtualSec() : Math.max(0, Number(when) || 0);
      pair.rec.stops.push({ when: t });
      bumpEnd(t);
    };
    return n;
  };
  FakeAudioContext.prototype.createBiquadFilter = function() {
    const pair = createNode(this, 'biquadFilter', { type: 'lowpass' }, { frequency: 350, Q: 1, gain: 0, detune: 0 });
    Object.defineProperty(pair.node, 'type', {
      get: function() { return pair.rec.props.type; },
      set: function(v) { pair.rec.props.type = v; }
    });
    return pair.node;
  };
  FakeAudioContext.prototype.createDynamicsCompressor = function() {
    return createNode(this, 'compressor', {}, { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }).node;
  };
  FakeAudioContext.prototype.createDelay = function(maxDelayTime) {
    return createNode(this, 'delay', { maxDelayTime: maxDelayTime || 1 }, { delayTime: 0 }).node;
  };
  FakeAudioContext.prototype.createStereoPanner = function() {
    return createNode(this, 'stereoPanner', {}, { pan: 0 }).node;
  };
  FakeAudioContext.prototype.createPanner = function() {
    return createNode(this, 'panner', {}, { positionX: 0, positionY: 0, positionZ: 0 }).node;
  };
  FakeAudioContext.prototype.createWaveShaper = function() {
    const pair = createNode(this, 'waveShaper', { curve: null, oversample: 'none' }, null);
    ['curve', 'oversample'].forEach(function(prop) {
      Object.defineProperty(pair.node, prop, {
        get: function() { return pair.rec.props[prop]; },
        set: function(v) { pair.rec.props[prop] = prop === 'curve' && v ? Array.from(v) : v; }
      });
    });
    return pair.node;
  };
  FakeAudioContext.prototype.createChannelSplitter = function(outputs) {
    return createNode(this, 'channelSplitter', { numberOfOutputs: outputs || 6 }, null).node;
  };
  FakeAudioContext.prototype.createChannelMerger = function(inputs) {
    return createNode(this, 'channelMerger', { numberOfInputs: inputs || 6 }, null).node;
  };
  FakeAudioContext.prototype.createAnalyser = function() {
    const pair = createNode(this, 'analyser', { fftSize: 2048 }, null);
    pair.node.frequencyBinCount = 1024;
    pair.node.getByteFrequencyData = function(arr) { if (arr) arr.fill(0); };
    pair.node.getByteTimeDomainData = function(arr) { if (arr) arr.fill(128); };
    pair.node.getFloatFrequencyData = function(arr) { if (arr) arr.fill(-100); };
    pair.node.getFloatTimeDomainData = function(arr) { if (arr) arr.fill(0); };
    return pair.node;
  };
  FakeAudioContext.prototype.createPeriodicWave = function(real, imag, constraints) {
    const pw = { __pwId: periodicWaves.length + 1, real: Array.from(real), imag: Array.from(imag), constraints: constraints };
    periodicWaves.push(pw);
    return pw;
  };
  FakeAudioContext.prototype.createMediaElementSource = function(el) {
    const pair = createNode(this, 'mediaElementSource', { src: el && (el.currentSrc || el.src) || '' }, null);
    return pair.node;
  };

  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;

  // Track <audio>, new Audio(), and <video> audio playback timestamps
  let mediaCounter = 1;
  function registerMedia(el) {
    if (el.__mediaTracked) return el.__mediaTracked;
    const rec = {
      id: mediaCounter++,
      tag: el.tagName ? el.tagName.toLowerCase() : 'audio',
      get src() { return el.currentSrc || el.src || (el.querySelector && el.querySelector('source') ? el.querySelector('source').src : ''); },
      events: [],
      volume: typeof el.volume === 'number' ? el.volume : 1,
      loop: Boolean(el.loop),
      playbackRate: typeof el.playbackRate === 'number' ? el.playbackRate : 1
    };
    el.__mediaTracked = rec;
    mediaEvents.push(rec);
    if (rec.src && !rec.src.startsWith('data:') && !rec.src.startsWith('blob:')) {
      if (window.__STAGE_DIAGNOSTICS__) {
        window.__STAGE_DIAGNOSTICS__.externalMediaDetected = true;
        window.__STAGE_DIAGNOSTICS__.mediaSources.push(rec.src);
      }
    }
    return rec;
  }

  const OrigAudio = window.Audio;
  window.Audio = function(src) {
    const el = new OrigAudio(src);
    registerMedia(el);
    return el;
  };
  window.Audio.prototype = OrigAudio.prototype;

  const origPlay = HTMLMediaElement.prototype.play;
  const origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.play = function() {
    const rec = registerMedia(this);
    rec.volume = this.muted ? 0 : this.volume;
    rec.loop = this.loop;
    rec.playbackRate = this.playbackRate || 1;
    const t = getVirtualSec();
    rec.events.push({ op: 'play', time: t, currentTime: this.currentTime || 0 });
    if (Number.isFinite(this.duration) && this.duration > 0) bumpEnd(t + this.duration);
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function() {
    if (this.__mediaTracked) {
      this.__mediaTracked.events.push({ op: 'pause', time: getVirtualSec() });
    }
    return origPause.apply(this, arguments);
  };

  window.__AUDIO_TRACER__ = {
    getMaxEndSec: function() { return maxEndSec; },
    exportGraph: function() {
      // Also inspect any <audio>/<video> elements with autoplay attribute
      const mediaEls = document.querySelectorAll('audio, video');
      for (let i = 0; i < mediaEls.length; i++) {
        const el = mediaEls[i];
        const rec = registerMedia(el);
        if (el.autoplay && rec.events.length === 0) {
          rec.events.push({ op: 'play', time: 0, currentTime: 0 });
        }
      }
      return {
        nodes: nodes.map(function(n) {
          const paramsOut = {};
          Object.keys(n.params).forEach(function(k) { paramsOut[k] = n.params[k].__export(); });
          return {
            id: n.id,
            kind: n.kind,
            props: n.props,
            params: paramsOut,
            starts: n.starts,
            stops: n.stops,
            bufferId: n.bufferId,
            periodicWaveId: n.periodicWaveId
          };
        }),
        connections: connections.slice(),
        buffers: buffers.map(function(b) {
          return {
            id: b.__bufferId,
            numberOfChannels: b.numberOfChannels,
            length: b.length,
            sampleRate: b.sampleRate,
            channels: b._channels
          };
        }),
        periodicWaves: periodicWaves.slice(),
        media: mediaEvents.map(function(m) {
          return {
            id: m.id,
            src: m.src,
            volume: m.volume,
            loop: m.loop,
            playbackRate: m.playbackRate,
            events: m.events
          };
        })
      };
    }
  };
})();
`;
}

/**
 * Replays the captured AudioGraph + media elements into an OfflineAudioContext
 * and returns a rendered AudioBuffer (or null if silent/no audio).
 */
export async function replayAudioOffline(graph, durationSec, sampleRate = 48000) {
  if (!graph) return { buffer: null, warnings: [] };
  const hasWebAudio = graph.nodes && graph.nodes.some((n) => n.kind !== 'destination');
  const hasMedia = graph.media && graph.media.some((m) => m.src && m.events.length > 0);
  if (!hasWebAudio && !hasMedia) {
    return { buffer: null, warnings: [] };
  }

  const totalSamples = Math.max(1, Math.ceil(durationSec * sampleRate));
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) {
    return { buffer: null, warnings: ['OfflineAudioContext unavailable'] };
  }

  const ctx = new OfflineCtx(2, totalSamples, sampleRate);
  const warnings = [];

  // 1. Reconstruct buffers
  const offlineBuffers = new Map();
  for (const b of graph.buffers || []) {
    try {
      const ab = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
      for (let c = 0; c < b.numberOfChannels; c++) {
        ab.getChannelData(c).set(b.channels[c]);
      }
      offlineBuffers.set(b.id, ab);
    } catch (_) {}
  }

  // 2. Reconstruct PeriodicWaves
  const offlineWaves = new Map();
  for (const pw of graph.periodicWaves || []) {
    try {
      offlineWaves.set(pw.id, ctx.createPeriodicWave(new Float32Array(pw.real), new Float32Array(pw.imag), pw.constraints));
    } catch (_) {}
  }

  // 3. Reconstruct Nodes
  const offlineNodes = new Map();
  for (const rec of graph.nodes || []) {
    let node = null;
    try {
      switch (rec.kind) {
        case 'destination':
          node = ctx.destination;
          break;
        case 'gain':
          node = ctx.createGain();
          break;
        case 'oscillator':
          node = ctx.createOscillator();
          if (rec.props.type) node.type = rec.props.type;
          if (rec.periodicWaveId && offlineWaves.has(rec.periodicWaveId)) {
            node.setPeriodicWave(offlineWaves.get(rec.periodicWaveId));
          }
          break;
        case 'constantSource':
          node = ctx.createConstantSource();
          break;
        case 'bufferSource':
          node = ctx.createBufferSource();
          if (rec.bufferId && offlineBuffers.has(rec.bufferId)) {
            node.buffer = offlineBuffers.get(rec.bufferId);
          }
          node.loop = Boolean(rec.props.loop);
          if (rec.props.loopStart) node.loopStart = rec.props.loopStart;
          if (rec.props.loopEnd) node.loopEnd = rec.props.loopEnd;
          break;
        case 'biquadFilter':
          node = ctx.createBiquadFilter();
          if (rec.props.type) node.type = rec.props.type;
          break;
        case 'compressor':
          node = ctx.createDynamicsCompressor();
          break;
        case 'delay':
          node = ctx.createDelay(rec.props.maxDelayTime || 1);
          break;
        case 'stereoPanner':
          node = ctx.createStereoPanner();
          break;
        case 'panner':
          node = ctx.createPanner();
          break;
        case 'waveShaper':
          node = ctx.createWaveShaper();
          if (rec.props.curve) node.curve = new Float32Array(rec.props.curve);
          if (rec.props.oversample) node.oversample = rec.props.oversample;
          break;
        case 'channelSplitter':
          node = ctx.createChannelSplitter(rec.props.numberOfOutputs || 6);
          break;
        case 'channelMerger':
          node = ctx.createChannelMerger(rec.props.numberOfInputs || 6);
          break;
        case 'analyser':
          // Pass-through gain so downstream connections remain intact
          node = ctx.createGain();
          break;
        case 'mediaElementSource':
          node = ctx.createGain();
          break;
        default:
          node = ctx.createGain();
      }
    } catch (e) {
      warnings.push(`Audio node ${rec.kind}: ${e.message}`);
    }

    if (!node) continue;
    offlineNodes.set(rec.id, node);

    // Apply AudioParam automation curves
    for (const [paramName, paramData] of Object.entries(rec.params || {})) {
      const param = node[paramName];
      if (!param) continue;
      const events = (paramData.events || []).slice().sort((a, b) => a.time - b.time);
      for (const ev of events) {
        try {
          const t = Math.max(0, ev.time);
          if (ev.op === 'setValueAtTime') {
            param.setValueAtTime(ev.value, t);
          } else if (ev.op === 'linearRampToValueAtTime') {
            param.linearRampToValueAtTime(ev.value, t);
          } else if (ev.op === 'exponentialRampToValueAtTime') {
            const safeVal = Math.abs(ev.value) < 1e-6 ? 1e-6 : ev.value;
            param.exponentialRampToValueAtTime(safeVal, t);
          } else if (ev.op === 'setTargetAtTime') {
            param.setTargetAtTime(ev.target, t, ev.timeConstant);
          } else if (ev.op === 'setValueCurveAtTime') {
            param.setValueCurveAtTime(new Float32Array(ev.values), t, ev.duration);
          } else if (ev.op === 'cancelScheduledValues') {
            param.cancelScheduledValues(t);
          } else if (ev.op === 'cancelAndHoldAtTime' && param.cancelAndHoldAtTime) {
            param.cancelAndHoldAtTime(t);
          }
        } catch (_) {}
      }
    }

    // Schedule starts & stops
    if (typeof node.start === 'function') {
      for (const st of rec.starts || []) {
        try {
          if (st.when < durationSec) {
            if (rec.kind === 'bufferSource' && st.duration !== undefined) {
              node.start(st.when, st.offset || 0, st.duration);
            } else if (rec.kind === 'bufferSource') {
              node.start(st.when, st.offset || 0);
            } else {
              node.start(st.when);
            }
          }
        } catch (_) {}
      }
      for (const sp of rec.stops || []) {
        try {
          node.stop(Math.min(durationSec, sp.when));
        } catch (_) {}
      }
    }
  }

  // 4. Connect Audio Graph
  for (const conn of graph.connections || []) {
    const src = offlineNodes.get(conn.from);
    const dst = offlineNodes.get(conn.to);
    if (src && dst) {
      try {
        src.connect(dst, conn.outIdx || 0, conn.inIdx || 0);
      } catch (_) {}
    }
  }

  // 5. Decode & schedule <audio> / new Audio() / <video> sources
  for (const m of graph.media || []) {
    if (!m.src || !m.events || m.events.length === 0) continue;
    try {
      const resp = await fetch(m.src);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arrBuf = await resp.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrBuf);
      // Pair play/pause intervals
      let playStart = null;
      let playOffset = 0;
      const intervals = [];
      for (const ev of m.events) {
        if (ev.op === 'play' && playStart === null) {
          playStart = ev.time;
          playOffset = ev.currentTime || 0;
        } else if (ev.op === 'pause' && playStart !== null) {
          intervals.push({ start: playStart, stop: ev.time, offset: playOffset });
          playStart = null;
        }
      }
      if (playStart !== null) {
        intervals.push({ start: playStart, stop: durationSec, offset: playOffset });
      }
      for (const iv of intervals) {
        if (iv.start >= durationSec) continue;
        const srcNode = ctx.createBufferSource();
        srcNode.buffer = decoded;
        srcNode.loop = m.loop;
        srcNode.playbackRate.value = m.playbackRate || 1;
        const gainNode = ctx.createGain();
        gainNode.gain.value = m.volume !== undefined ? m.volume : 1;
        srcNode.connect(gainNode);
        gainNode.connect(ctx.destination);
        srcNode.start(iv.start, iv.offset);
        srcNode.stop(Math.min(durationSec, iv.stop));
      }
    } catch (err) {
      warnings.push(`Could not decode media (${m.src}): ${err.message}`);
    }
  }

  const rendered = await ctx.startRendering();
  return { buffer: rendered, warnings };
}
