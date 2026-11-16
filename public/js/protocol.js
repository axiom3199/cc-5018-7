// Wire protocol and runtime constants shared by the host page, the guest page,
// the relay, the kernel worker and the AudioWorklets. Times are integer
// microseconds unless a name ends in Ms/EpochMs.

export const PROTOCOL_VERSION = 2;
export const SAMPLE_RATE = 48000;
export const FRAME_SAMPLES = 960; // 20 ms Opus frame at 48 kHz
export const FRAME_US = 20000;
export const CHANNELS = 1;
export const OPUS_BITRATE = 64000;

// AudioWorklet playout ring. Power of two so the worklet can mask instead of
// divide. 2^18 samples = 5.46 s of headroom, far above the 400 ms target bound.
export const RING_SAMPLES = 1 << 18;
export const RING_MASK = RING_SAMPLES - 1;
export const RING_BYTE_OFFSET = 4096; // leaves room for Int32/Float64 control

// Monitor tap: a second ring the worklet fills with exactly what was sent to
// the sound card. Used by the host UI scope and by the end-to-end tests to
// verify sample placement, gaps and continuity without guessing.
export const MON_SAMPLES = 1 << 17; // 2.73 s
export const MON_MASK = MON_SAMPLES - 1;
export const MON_BYTE_OFFSET = RING_BYTE_OFFSET + RING_SAMPLES * 4;
export const SAB_BYTES = MON_BYTE_OFFSET + MON_SAMPLES * 4 + 4096;

// Int32 shared slots. The worklet publishes device state; the kernel publishes
// write position, target, playing flag and simulated sound-card skew.
export const SAB = {
  WRITE_SAMPLE: 0,
  READ_SAMPLE: 1,
  TARGET_SAMPLES: 2,
  PLAYING: 3,
  DEVICE_SKEW_PPM: 4,
  COMMAND: 5,
  ACK: 6,
  UNDERRUNS: 7,
  PLAYED_SAMPLES: 8,
  RATIO_PPM: 9,
  RMS: 10,
  PEAK: 11,
  OCCUPANCY: 12,
  MON_WRITE: 13,
  MON_ENABLE: 14,
  INT_SLOTS: 16,
};

export const SAB_COMMAND = { NONE: 0, FLUSH: 1 };

export const MSG = {
  HELLO: 'hello',
  WELCOME: 'welcome',
  START: 'start',
  STOP: 'stop',
  MEDIA: 'media',
  FEEDBACK: 'feedback',
  STATS: 'stats',
  PEER_STATE: 'peer-state',
  CONTROL: 'control',
  CONTROL_ACK: 'control-ack',
  MARKER: 'marker',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',
};

export const ROLES = { GUEST: 'guest', HOST: 'host' };

// Binary media header: 'RAL2', version, flags, reserved, seq, mediaStartUs.
// 20-byte header followed by one Opus packet.
export const MEDIA_MAGIC = 0x324c4152; // little-endian 'RAL2'
export const MEDIA_HEADER_BYTES = 20;
export const MEDIA_FLAG_NONE = 0;

// Jitter-buffer tunables. Unit tests and the runtime share these numbers.
export const JITTER = {
  MIN_MS: 40,
  INITIAL_MS: 120,
  MAX_MS: 400,
  STEP_UP_MS: 30,
  STEP_DOWN_MS: 5,
  STEP_INTERVAL_MS: 3000,
  EWMA_ALPHA: 0.125,
  RAISE_COOLDOWN_MS: 2000,
  REPAIR_WAIT_MS: 70,
  MAX_GAP_FRAMES: 25,
  UNDERRUN_WINDOW_MS: 2000,
  UNDERRUN_RAISE_MS: 40,
  DRIFT_MAX_RATIO: 0.01,
  DRIFT_GAIN_PER_MS: 0.0005,
  MAX_QUEUE_MS: 1200,
  START_MARGIN_MS: 20,
  // Manual target bias range exposed by the host UI.
  TARGET_BIAS_MIN_MS: -60,
  TARGET_BIAS_MAX_MS: 200,
};

export const NETWORK_PROFILES = {
  clean: { label: '干净链路', baseMs: 0, jitterMs: 0, lossPct: 0, reorderPct: 0, dupPct: 0 },
  steady: { label: '稳定抖动', baseMs: 70, jitterMs: 12, lossPct: 0.2, reorderPct: 0.5, dupPct: 0 },
  bursty: { label: '突发抖动', baseMs: 80, jitterMs: 25, lossPct: 0.5, reorderPct: 1.5, dupPct: 1 },
  heavy: { label: '高抖动', baseMs: 180, jitterMs: 65, lossPct: 1, reorderPct: 3, dupPct: 2 },
  spike: {
    label: '延迟尖峰',
    baseMs: 70,
    jitterMs: 18,
    lossPct: 0.3,
    reorderPct: 1,
    dupPct: 0,
    burst: { everyMs: 2500, lengthMs: 500, extraMs: 150 },
  },
  step: {
    label: '延迟阶跃',
    baseMs: 60,
    jitterMs: 15,
    lossPct: 0.3,
    reorderPct: 1,
    dupPct: 0,
    step: { atMs: 4000, extraMs: 140 },
  },
  drift: {
    label: '缓慢漂移',
    baseMs: 90,
    jitterMs: 8,
    lossPct: 0.2,
    reorderPct: 0.5,
    dupPct: 0,
    wobble: { periodMs: 12000, amplitudeMs: 60 },
  },
  custom: { label: '自定义', baseMs: 80, jitterMs: 30, lossPct: 1, reorderPct: 2, dupPct: 1 },
};

export const TEST_SOURCES = {
  tone: '持续音 440 Hz',
  pulse: '脉冲 1 kHz',
  speech: '语音播报',
  mic: '麦克风',
};

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function msToSamples(ms) {
  return Math.round((ms * SAMPLE_RATE) / 1000);
}

export function samplesToMs(samples) {
  return (samples * 1000) / SAMPLE_RATE;
}

export function encodeMediaPacket(seq, mediaStartUs, payload, flags = 0) {
  const buf = new ArrayBuffer(MEDIA_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, MEDIA_MAGIC, true);
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, flags);
  view.setUint16(6, 0, true);
  view.setUint32(8, seq >>> 0, true);
  view.setBigUint64(12, BigInt(mediaStartUs), true);
  new Uint8Array(buf, MEDIA_HEADER_BYTES).set(payload);
  return buf;
}

export function decodeMediaPacket(arrayBuffer) {
  if (arrayBuffer.byteLength < MEDIA_HEADER_BYTES) return null;
  const view = new DataView(arrayBuffer);
  if (view.getUint32(0, true) !== MEDIA_MAGIC) return null;
  const version = view.getUint8(4);
  if (version !== PROTOCOL_VERSION) return null;
  return {
    version,
    flags: view.getUint8(5),
    seq: view.getUint32(8, true),
    mediaStartUs: Number(view.getBigUint64(12, true)),
    payload: new Uint8Array(arrayBuffer, MEDIA_HEADER_BYTES),
  };
}

// Capture needs to run WebCodecs on an AudioWorklet's nominal 48 kHz. When the
// device ignores the requested rate (common on Bluetooth/aggregate devices),
// the kernel resamples each block with this streaming linear resampler.
export class StreamResampler {
  constructor(inRate, outRate) {
    this.step = inRate / outRate;
    this.identity = Math.abs(inRate - outRate) < 1e-9;
    this.buf = new Float32Array(0);
    this.pos = 0;
  }

  push(block) {
    if (this.identity) return block;
    const merged = new Float32Array(this.buf.length + block.length);
    merged.set(this.buf, 0);
    merged.set(block, this.buf.length);
    const out = [];
    let pos = this.pos;
    while (Math.floor(pos) + 1 < merged.length) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      out.push(merged[i0] + (merged[i0 + 1] - merged[i0]) * frac);
      pos += this.step;
    }
    const keepFrom = Math.min(Math.floor(pos), merged.length - 1);
    this.buf = merged.slice(keepFrom);
    this.pos = pos - keepFrom;
    return new Float32Array(out);
  }
}
