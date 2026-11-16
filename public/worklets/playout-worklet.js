// Playout AudioWorklet. Owns the device side of the ring buffer:
//   - reads PCM at the sound-card rate, optionally with simulated clock skew
//   - never advances past the writer; starvation is reported, not hidden
//   - publishes read position, played samples, RMS/peak and occupancy to SAB
//   - mirrors exactly what it emitted into a monitor ring for scope/tests
//   - fades in briefly on every (re)start so restarts do not click
//
// It knows nothing about Opus, sequence numbers or jitter. The kernel worker
// fills the ring with a continuous, explicitly gap-concealed timeline.

import {
  RING_SAMPLES,
  RING_MASK,
  RING_BYTE_OFFSET,
  MON_SAMPLES,
  MON_MASK,
  MON_BYTE_OFFSET,
  SAB,
  SAB_COMMAND,
} from '/js/protocol.js';

const FADE_SAMPLES = 64;

class PlayoutProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { ringSab } = options.processorOptions;
    this.ctrl = new Int32Array(ringSab, 0, SAB.INT_SLOTS);
    this.f64 = new Float64Array(ringSab, 1024, 8);
    this.ring = new Float32Array(ringSab, RING_BYTE_OFFSET, RING_SAMPLES);
    this.mon = new Float32Array(ringSab, MON_BYTE_OFFSET, MON_SAMPLES);
    this.readPos = 0;
    this.monPos = 0;
    this.fade = 0;
    this.wasPlaying = false;
    this.lastAck = Atomics.load(this.ctrl, SAB.ACK);
    this.reportCounter = 0;
    this.rmsAcc = 0;
    this.rmsN = 0;
    this.peak = 0;
    this.port.postMessage({ type: 'worklet-ready', sampleRate: globalThis.sampleRate });
  }

  _applyCommand() {
    const cmd = Atomics.load(this.ctrl, SAB.COMMAND);
    const ack = Atomics.load(this.ctrl, SAB.ACK);
    if (cmd !== SAB_COMMAND.NONE && ack === this.lastAck) {
      if (cmd === SAB_COMMAND.FLUSH) {
        this.readPos = Atomics.load(this.ctrl, SAB.WRITE_SAMPLE) >>> 0;
        this.f64[0] = this.readPos;
        this.fade = 0;
      }
      this.lastAck = ack + 1;
      Atomics.store(this.ctrl, SAB.ACK, this.lastAck);
      Atomics.store(this.ctrl, SAB.COMMAND, 0);
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    this._applyCommand();

    const playing = Atomics.load(this.ctrl, SAB.PLAYING) === 1;
    const skewPpm = Atomics.load(this.ctrl, SAB.DEVICE_SKEW_PPM);
    const rate = 1 + skewPpm / 1e6;
    const monEnabled = Atomics.load(this.ctrl, SAB.MON_ENABLE) === 1;

    if (!playing) {
      out.fill(0);
      this.wasPlaying = false;
      this.fade = 0;
      Atomics.store(this.ctrl, SAB.OCCUPANCY, 0);
      Atomics.store(this.ctrl, SAB.READ_SAMPLE, Math.floor(this.readPos));
      if (monEnabled) this._writeMonitor(out);
      return true;
    }

    const write = Atomics.load(this.ctrl, SAB.WRITE_SAMPLE) >>> 0;
    if (!this.wasPlaying) {
      this.wasPlaying = true;
      this.fade = 0;
    }

    let pos = this.readPos;
    let starved = false;

    for (let i = 0; i < out.length; i++) {
      pos += rate;
      const idx = Math.floor(pos);
      if (idx >= write) {
        starved = true;
        out.fill(0, i);
        break;
      }
      const i0 = (idx & RING_MASK) >>> 0;
      const i1 = ((idx + 1) & RING_MASK) >>> 0;
      const frac = pos - idx;
      let v = this.ring[i0] + (this.ring[i1] - this.ring[i0]) * frac;
      if (this.fade < FADE_SAMPLES) {
        this.fade++;
        v *= this.fade / FADE_SAMPLES;
      }
      out[i] = v;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      this.rmsAcc += v * v;
      this.rmsN++;
    }

    if (pos > write) pos = write;
    this.readPos = pos;
    this.f64[0] = pos;

    if (starved) {
      // The ring ran dry. Stop, report once, and let the kernel rebase the
      // media period instead of playing stale or misplaced samples.
      Atomics.store(this.ctrl, SAB.PLAYING, 0);
      Atomics.add(this.ctrl, SAB.UNDERRUNS, 1);
      this.wasPlaying = false;
      this.fade = 0;
      this.port.postMessage({ type: 'underrun', readPos: Math.floor(pos), write });
    }

    const played = Math.floor(pos);
    Atomics.store(this.ctrl, SAB.READ_SAMPLE, played);
    Atomics.store(this.ctrl, SAB.PLAYED_SAMPLES, played & 0x7fffffff);
    Atomics.store(this.ctrl, SAB.OCCUPANCY, Math.max(0, write - played));
    if (monEnabled) this._writeMonitor(out);

    this.reportCounter += out.length;
    if (this.reportCounter >= 2400) {
      // ~20 Hz level reporting.
      const rms = this.rmsN ? Math.sqrt(this.rmsAcc / this.rmsN) : 0;
      Atomics.store(this.ctrl, SAB.RMS, Math.round(rms * 10000));
      Atomics.store(this.ctrl, SAB.PEAK, Math.round(this.peak * 10000));
      this.rmsAcc = 0;
      this.rmsN = 0;
      this.peak = 0;
      this.reportCounter = 0;
    }
    return true;
  }

  _writeMonitor(out) {
    const start = this.monPos & MON_MASK;
    for (let i = 0; i < out.length; i++) this.mon[(start + i) & MON_MASK] = out[i];
    this.monPos += out.length;
    Atomics.store(this.ctrl, SAB.MON_WRITE, this.monPos & 0x7fffffff);
  }
}

registerProcessor('playout', PlayoutProcessor);
