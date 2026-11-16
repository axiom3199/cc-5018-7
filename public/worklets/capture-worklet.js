// Capture AudioWorklet. Produces exactly 960-sample (20 ms) media blocks on the
// real sound-card clock, either from its input (microphone or a decoded speech
// buffer) or from an internally generated test signal. Each block is
// transferred to the kernel with its media sample index, so timestamps come
// from the capture clock rather than from a JavaScript timer.
//
// Test signals are sample-accurate and deterministic:
//   tone  : 440 Hz sine
//   pulse : 1 kHz sine gated 120 ms on / 380 ms off (gap and latency probe)
//   speech: whatever is connected to the input (decoded programme audio)
//   mic   : whatever is connected to the input (microphone)

const FRAME = 960;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.mode = o.mode || 'tone';
    this.gain = o.gain ?? 0.35;
    this.phase = 0;
    this.pulsePos = 0;
    this.chunk = new Float32Array(FRAME);
    this.fill = 0;
    this.chunkIndex = 0;
    this.markerPending = false;
    this.lastMarker = null;
    this.peak = 0;
    this.reportAcc = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'marker') {
        this.markerPending = true;
        this.lastMarker = m;
      } else if (m.type === 'mode') {
        this.mode = m.mode;
        this.phase = 0;
        this.pulsePos = 0;
      } else if (m.type === 'gain') {
        this.gain = m.gain;
      }
    };
    this.port.postMessage({ type: 'capture-ready', mode: this.mode, sampleRate });
  }

  _synth() {
    if (this.mode === 'pulse') {
      const on = this.pulsePos < 5760; // 120 ms of a 500 ms period
      this.pulsePos = (this.pulsePos + 1) % 24000;
      if (!on) return 0;
    }
    this.phase += (2 * Math.PI * 440) / 48000;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    return Math.sin(this.phase);
  }

  process(inputs, _outputs) {
    const input = inputs[0] && inputs[0][0];
    const n = input ? input.length : 128;

    for (let i = 0; i < n; i++) {
      let v;
      if (this.mode === 'tone' || this.mode === 'pulse') {
        v = this._synth();
      } else {
        v = input ? input[i] : 0;
      }
      v *= this.gain;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      this.chunk[this.fill++] = v;
      if (this.fill === FRAME) {
        const out = this.chunk;
        const marker = this.markerPending ? this.lastMarker : null;
        this.markerPending = false;
        this.port.postMessage(
          { type: 'frame', seq: this.chunkIndex, sampleStart: this.chunkIndex * FRAME, pcm: out, marker },
          [out.buffer],
        );
        this.chunk = new Float32Array(FRAME);
        this.fill = 0;
        this.chunkIndex++;
      }
    }

    this.reportAcc += n;
    if (this.reportAcc >= 2400) {
      this.reportAcc = 0;
      this.port.postMessage({ type: 'level', peak: this.peak, chunkIndex: this.chunkIndex });
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
