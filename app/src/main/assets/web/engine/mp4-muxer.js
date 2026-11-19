/**
 * Self-contained, spec-compliant ISO BMFF / MP4 Muxer for WebCodecs H.264 + AAC.
 * Produces standard fast-playing MP4 files compatible with Android, iOS, Chrome, and FFmpeg.
 */

const TEXT_ENCODER = new TextEncoder();

function u16(v) {
  return [(v >>> 8) & 0xff, v & 0xff];
}

function u32(v) {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function strBytes(s) {
  return Array.from(TEXT_ENCODER.encode(s));
}

function box(type, ...parts) {
  let len = 8;
  for (const p of parts) {
    len += p.length;
  }
  const out = new Uint8Array(len);
  const view = new DataView(out.buffer);
  view.setUint32(0, len);
  out.set(TEXT_ENCODER.encode(type), 4);
  let offset = 8;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function fullBox(type, version, flags, ...parts) {
  const header = new Uint8Array([
    version & 0xff,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff
  ]);
  return box(type, header, ...parts);
}

function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function buildAudioSpecificConfig(sampleRate, channels) {
  const freqTable = [
    96000, 88200, 64000, 48000, 44100, 32000,
    24000, 22050, 16000, 12000, 11025, 8000, 7350
  ];
  let freqIdx = freqTable.indexOf(sampleRate);
  if (freqIdx < 0) freqIdx = 3; // fallback 48000
  const audioObjectType = 2; // AAC-LC
  const byte0 = ((audioObjectType << 3) | (freqIdx >> 1)) & 0xff;
  const byte1 = (((freqIdx & 1) << 7) | ((channels & 0x0f) << 3)) & 0xff;
  return new Uint8Array([byte0, byte1]);
}

function isAnnexB(data) {
  if (data.length < 4) return false;
  return (
    (data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1) ||
    (data[0] === 0 && data[1] === 0 && data[2] === 1)
  );
}

function splitAnnexBNalus(data) {
  const nalus = [];
  let i = 0;
  let start = -1;
  while (i < data.length - 2) {
    let scLen = 0;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) scLen = 3;
    else if (i < data.length - 3 && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) scLen = 4;
    if (scLen > 0) {
      if (start >= 0 && i > start) {
        nalus.push(data.subarray(start, i));
      }
      start = i + scLen;
      i += scLen;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) {
    nalus.push(data.subarray(start));
  }
  return nalus;
}

function buildAvcCFromSpsPps(sps, pps) {
  const out = [
    1, // configurationVersion
    sps[1] || 0x42, // AVCProfileIndication
    sps[2] || 0x00, // profile_compatibility
    sps[3] || 0x1f, // AVCLevelIndication
    0xff, // lengthSizeMinusOne = 3 (4-byte NALU lengths)
    0xe1, // numOfSequenceParameterSets = 1
    ...u16(sps.length),
    ...sps,
    1, // numOfPictureParameterSets = 1
    ...u16(pps.length),
    ...pps
  ];
  return new Uint8Array(out);
}

function annexBToAvcc(data) {
  const nalus = splitAnnexBNalus(data);
  let sps = null;
  let pps = null;
  const filtered = [];
  for (const n of nalus) {
    if (n.length === 0) continue;
    const type = n[0] & 0x1f;
    if (type === 7) sps = n;
    else if (type === 8) pps = n;
    filtered.push(n);
  }
  let total = 0;
  for (const n of filtered) total += 4 + n.length;
  const avcc = new Uint8Array(total);
  const view = new DataView(avcc.buffer);
  let off = 0;
  for (const n of filtered) {
    view.setUint32(off, n.length);
    avcc.set(n, off + 4);
    off += 4 + n.length;
  }
  return { payload: avcc, sps, pps };
}

export class Mp4Muxer {
  constructor({ width, height, fps = 30, hasAudio = false, sampleRate = 48000, channels = 2 }) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.hasAudio = hasAudio;
    this.sampleRate = sampleRate;
    this.channels = channels;

    this.videoTimescale = 90000;
    this.audioTimescale = sampleRate;

    this.videoSamples = []; // { data, durationTs, isKey }
    this.audioSamples = []; // { data, durationTs }
    this.avcDescription = null;
    this.audioDescription = null;
    this._sps = null;
    this._pps = null;
  }

  addVideoChunk(chunk, meta) {
    const raw = new Uint8Array(chunk.byteLength);
    chunk.copyTo(raw);

    if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.avcDescription) {
      const desc = meta.decoderConfig.description;
      this.avcDescription = desc instanceof Uint8Array ? desc : new Uint8Array(desc);
    }

    let payload = raw;
    if (isAnnexB(raw)) {
      const conv = annexBToAvcc(raw);
      payload = conv.payload;
      if (conv.sps) this._sps = conv.sps;
      if (conv.pps) this._pps = conv.pps;
      if (!this.avcDescription && this._sps && this._pps) {
        this.avcDescription = buildAvcCFromSpsPps(this._sps, this._pps);
      }
    }

    const durSec = chunk.duration ? chunk.duration / 1e6 : 1 / this.fps;
    const durationTs = Math.max(1, Math.round(durSec * this.videoTimescale));
    this.videoSamples.push({
      data: payload,
      durationTs,
      isKey: chunk.type === 'key'
    });
  }

  addAudioChunk(chunk, meta) {
    const raw = new Uint8Array(chunk.byteLength);
    chunk.copyTo(raw);

    if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.audioDescription) {
      const desc = meta.decoderConfig.description;
      this.audioDescription = desc instanceof Uint8Array ? desc : new Uint8Array(desc);
    }

    const durSec = chunk.duration ? chunk.duration / 1e6 : 1024 / this.sampleRate;
    const durationTs = Math.max(1, Math.round(durSec * this.audioTimescale));
    this.audioSamples.push({
      data: raw,
      durationTs
    });
  }

  _buildStts(samples) {
    const entries = [];
    for (const s of samples) {
      const last = entries[entries.length - 1];
      if (last && last.delta === s.durationTs) {
        last.count++;
      } else {
        entries.push({ count: 1, delta: s.durationTs });
      }
    }
    const buf = new Uint8Array(4 + entries.length * 8);
    const view = new DataView(buf.buffer);
    view.setUint32(0, entries.length);
    let off = 4;
    for (const e of entries) {
      view.setUint32(off, e.count);
      view.setUint32(off + 4, e.delta);
      off += 8;
    }
    return fullBox('stts', 0, 0, buf);
  }

  _buildStss(samples) {
    const keys = [];
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].isKey) keys.push(i + 1);
    }
    if (keys.length === 0 && samples.length > 0) keys.push(1);
    const buf = new Uint8Array(4 + keys.length * 4);
    const view = new DataView(buf.buffer);
    view.setUint32(0, keys.length);
    for (let i = 0; i < keys.length; i++) {
      view.setUint32(4 + i * 4, keys[i]);
    }
    return fullBox('stss', 0, 0, buf);
  }

  _buildStsc() {
    // 1 sample per chunk for all chunks
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 1); // entry_count
    view.setUint32(4, 1); // first_chunk
    view.setUint32(8, 1); // samples_per_chunk
    view.setUint32(12, 1); // sample_description_index
    return fullBox('stsc', 0, 0, buf);
  }

  _buildStsz(samples) {
    const buf = new Uint8Array(8 + samples.length * 4);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0); // variable sample size
    view.setUint32(4, samples.length);
    for (let i = 0; i < samples.length; i++) {
      view.setUint32(8 + i * 4, samples[i].data.length);
    }
    return fullBox('stsz', 0, 0, buf);
  }

  _buildStco(offsets) {
    const buf = new Uint8Array(4 + offsets.length * 4);
    const view = new DataView(buf.buffer);
    view.setUint32(0, offsets.length);
    for (let i = 0; i < offsets.length; i++) {
      view.setUint32(4 + i * 4, offsets[i]);
    }
    return fullBox('stco', 0, 0, buf);
  }

  _buildVideoTrak(trackId, offsets) {
    const totalDurTs = this.videoSamples.reduce((acc, s) => acc + s.durationTs, 0);
    const mvhdDur = Math.round((totalDurTs / this.videoTimescale) * 1000);

    const tkhd = fullBox(
      'tkhd', 0, 3,
      new Uint8Array([
        0, 0, 0, 0, // creation_time
        0, 0, 0, 0, // modification_time
        ...u32(trackId),
        0, 0, 0, 0, // reserved
        ...u32(mvhdDur),
        0, 0, 0, 0, 0, 0, 0, 0, // reserved
        0, 0, 0, 0, // layer, alternate_group
        0, 0, 0, 0, // volume, reserved
        // identity matrix
        0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 64, 0, 0, 0,
        ...u16(this.width), 0, 0,
        ...u16(this.height), 0, 0
      ])
    );

    const mdhd = fullBox(
      'mdhd', 0, 0,
      new Uint8Array([
        0, 0, 0, 0, // creation_time
        0, 0, 0, 0, // modification_time
        ...u32(this.videoTimescale),
        ...u32(totalDurTs),
        0x55, 0xc4, // 'und'
        0, 0
      ])
    );

    const hdlr = fullBox(
      'hdlr', 0, 0,
      new Uint8Array([
        0, 0, 0, 0,
        ...strBytes('vide'),
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ...strBytes('VideoHandler'), 0
      ])
    );

    const vmhd = fullBox('vmhd', 0, 1, new Uint8Array(8));
    const urlBox = fullBox('url ', 0, 1);
    const dref = fullBox('dref', 0, 0, new Uint8Array(u32(1)), urlBox);
    const dinf = box('dinf', dref);

    const avcCData = this.avcDescription || new Uint8Array([1, 0x42, 0x00, 0x1f, 0xff, 0xe0, 0]);
    const avcC = box('avcC', avcCData);
    const avc1Header = new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 1, // reserved + data_ref_idx
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // pre_defined + reserved
      ...u16(this.width),
      ...u16(this.height),
      0x00, 0x48, 0x00, 0x00, // 72 dpi
      0x00, 0x48, 0x00, 0x00,
      0, 0, 0, 0, // reserved
      0, 1, // frame_count
      ...new Array(32).fill(0), // compressorname
      0x00, 0x18, // depth = 24
      0xff, 0xff // pre_defined = -1
    ]);
    const avc1 = box('avc1', avc1Header, avcC);
    const stsd = fullBox('stsd', 0, 0, new Uint8Array(u32(1)), avc1);

    const stbl = box(
      'stbl',
      stsd,
      this._buildStts(this.videoSamples),
      this._buildStss(this.videoSamples),
      this._buildStsc(),
      this._buildStsz(this.videoSamples),
      this._buildStco(offsets)
    );

    const minf = box('minf', vmhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    return { trak: box('trak', tkhd, mdia), durationMs: mvhdDur };
  }

  _buildAudioTrak(trackId, offsets) {
    const totalDurTs = this.audioSamples.reduce((acc, s) => acc + s.durationTs, 0);
    const mvhdDur = Math.round((totalDurTs / this.audioTimescale) * 1000);

    const tkhd = fullBox(
      'tkhd', 0, 3,
      new Uint8Array([
        0, 0, 0, 0,
        0, 0, 0, 0,
        ...u32(trackId),
        0, 0, 0, 0,
        ...u32(mvhdDur),
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0,
        0x01, 0x00, 0, 0, // volume = 1.0
        0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 64, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0
      ])
    );

    const mdhd = fullBox(
      'mdhd', 0, 0,
      new Uint8Array([
        0, 0, 0, 0,
        0, 0, 0, 0,
        ...u32(this.audioTimescale),
        ...u32(totalDurTs),
        0x55, 0xc4,
        0, 0
      ])
    );

    const hdlr = fullBox(
      'hdlr', 0, 0,
      new Uint8Array([
        0, 0, 0, 0,
        ...strBytes('soun'),
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ...strBytes('SoundHandler'), 0
      ])
    );

    const smhd = fullBox('smhd', 0, 0, new Uint8Array(4));
    const urlBox = fullBox('url ', 0, 1);
    const dref = fullBox('dref', 0, 0, new Uint8Array(u32(1)), urlBox);
    const dinf = box('dinf', dref);

    const asc = this.audioDescription && this.audioDescription.length >= 2
      ? this.audioDescription
      : buildAudioSpecificConfig(this.sampleRate, this.channels);

    const decSpecInfo = new Uint8Array([0x05, asc.length, ...asc]);
    const decConfig = new Uint8Array([
      0x04, 13 + decSpecInfo.length,
      0x40, // MPEG-4 Audio
      0x15, // AudioStream
      0, 0, 0, // bufferSizeDB
      ...u32(128000), // maxBitrate
      ...u32(128000), // avgBitrate
      ...decSpecInfo
    ]);
    const slConfig = new Uint8Array([0x06, 0x01, 0x02]);
    const esDescr = new Uint8Array([
      0x03, 3 + decConfig.length + slConfig.length,
      0x00, 0x01, // ES_ID
      0x00, // streamDependenceFlag=0
      ...decConfig,
      ...slConfig
    ]);
    const esds = fullBox('esds', 0, 0, esDescr);

    const mp4aHeader = new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 1, // reserved + data_ref_idx
      0, 0, 0, 0, 0, 0, 0, 0, // reserved
      ...u16(this.channels),
      ...u16(16), // sampleSize
      0, 0, 0, 0, // pre_defined + reserved
      ...u16(this.sampleRate), 0, 0 // sampleRate fixed 16.16
    ]);
    const mp4a = box('mp4a', mp4aHeader, esds);
    const stsd = fullBox('stsd', 0, 0, new Uint8Array(u32(1)), mp4a);

    const stbl = box(
      'stbl',
      stsd,
      this._buildStts(this.audioSamples),
      this._buildStsc(),
      this._buildStsz(this.audioSamples),
      this._buildStco(offsets)
    );

    const minf = box('minf', smhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    return { trak: box('trak', tkhd, mdia), durationMs: mvhdDur };
  }

  finalize() {
    const ftyp = box(
      'ftyp',
      new Uint8Array([
        ...strBytes('isom'),
        ...u32(512),
        ...strBytes('isom'),
        ...strBytes('iso2'),
        ...strBytes('avc1'),
        ...strBytes('mp41')
      ])
    );

    // Compute mdat size and exact sample offsets
    let mdatPayloadSize = 0;
    for (const s of this.videoSamples) mdatPayloadSize += s.data.length;
    for (const s of this.audioSamples) mdatPayloadSize += s.data.length;

    const mdatHeaderSize = 8;
    const mdatOffsetBase = ftyp.length + mdatHeaderSize;

    const mdatBuf = new Uint8Array(mdatHeaderSize + mdatPayloadSize);
    const mdatView = new DataView(mdatBuf.buffer);
    mdatView.setUint32(0, mdatBuf.length);
    mdatBuf.set(TEXT_ENCODER.encode('mdat'), 4);

    let cursor = mdatHeaderSize;
    const videoOffsets = [];
    for (const s of this.videoSamples) {
      videoOffsets.push(ftyp.length + cursor);
      mdatBuf.set(s.data, cursor);
      cursor += s.data.length;
    }

    const audioOffsets = [];
    for (const s of this.audioSamples) {
      audioOffsets.push(ftyp.length + cursor);
      mdatBuf.set(s.data, cursor);
      cursor += s.data.length;
    }

    const traks = [];
    let maxDurMs = 0;
    let nextTrackId = 1;

    const vResult = this._buildVideoTrak(nextTrackId++, videoOffsets);
    traks.push(vResult.trak);
    maxDurMs = Math.max(maxDurMs, vResult.durationMs);

    if (this.audioSamples.length > 0) {
      const aResult = this._buildAudioTrak(nextTrackId++, audioOffsets);
      traks.push(aResult.trak);
      maxDurMs = Math.max(maxDurMs, aResult.durationMs);
    }

    const mvhd = fullBox(
      'mvhd', 0, 0,
      new Uint8Array([
        0, 0, 0, 0, // creation_time
        0, 0, 0, 0, // modification_time
        ...u32(1000), // timescale = 1000ms
        ...u32(maxDurMs),
        0x00, 0x01, 0x00, 0x00, // rate 1.0
        0x01, 0x00, // volume 1.0
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // reserved
        0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 64, 0, 0, 0,
        ...new Array(24).fill(0),
        ...u32(nextTrackId)
      ])
    );

    const moov = box('moov', mvhd, ...traks);
    return concatBytes(ftyp, mdatBuf, moov);
  }
}
