// Thin page-side façade over the kernel worker. It owns nothing about media:
// it spawns the worker, forwards commands, and fans out state/telemetry events
// to the UI. All buffer decisions happen inside the kernel.

export class RemoteAudioClient {
  constructor({ onEvent } = {}) {
    this.onEvent = onEvent || (() => {});
    this.worker = null;
    this.stats = {};
    this.role = null;
    this.state = {
      ready: false,
      running: false,
      connected: false,
      peerPresent: false,
      period: 0,
      playing: false,
      targetMs: 120,
      occupancyMs: 0,
      errors: [],
      events: [],
    };
  }

  _emit(type, payload) {
    this.onEvent(type, payload);
  }

  async init(role, options) {
    this.role = role;
    this.worker = new Worker('/js/kernel-worker.js', { type: 'module' });
    this.worker.onmessage = (e) => {
      const { type, ...payload } = e.data;
      if (type === 'stats' && payload.stats) {
        this.stats = payload.stats;
        this.state.targetMs = payload.stats.targetMs;
        this.state.occupancyMs = payload.stats.occupancyMs;
        this.state.connected = payload.stats.connected;
      }
      if (type === 'welcome') {
        this.state.period = payload.period;
        this.state.peerPresent = !!payload.peerPresent;
      }
      if (type === 'peer-state') {
        this.state.peerPresent = role === 'guest' ? payload.hostConnected : payload.guestConnected;
      }
      if (type === 'playing') this.state.playing = true;
      if (type === 'underrun' || type === 'period-end' || type === 'rebase') this.state.playing = false;
      if (type === 'error') {
        this.state.errors.push({ at: Date.now(), message: payload.message });
        if (this.state.errors.length > 20) this.state.errors.shift();
      }
      if (type === 'ring-ready') this.state.ring = payload;
      this._emit(type, payload);
    };
    this.worker.onerror = (e) => {
      this._emit('error', { message: e.message || 'worker error' });
    };
    this.worker.postMessage({ type: role === 'guest' ? 'init-guest' : 'init-host', options });
    this.state.ready = true;
    return this;
  }

  send(msg) {
    this.worker?.postMessage(msg);
  }

  start() {
    this.state.running = true;
    this.send({ type: 'start-media' });
  }

  marker(label = 'marker') {
    this.send({ type: 'marker', label });
  }

  control(action, extra = {}) {
    this.send({ type: 'control', action, ...extra });
  }

  captureFrame(frame) {
    this.send({ type: 'capture-frame', pcm: frame.pcm, sampleStart: frame.sampleStart, seq: frame.seq, marker: frame.marker }, [frame.pcm]);
  }

  captureLevel(peak, chunkIndex) {
    this.send({ type: 'capture-level', peak, chunkIndex });
  }

  audioReady(info) {
    this.send({ type: 'audio-ready', info });
  }

  audioUnderrun(detail) {
    this.send({ type: 'audio-underrun', detail });
  }

  feedback(msg) {
    this.send({ type: 'feedback', ...msg });
  }

  simulate(params) {
    this.send({ type: 'simulate', params });
  }

  reconnect(options = {}) {
    this.send({ type: 'reconnect', options });
  }

  destroy() {
    this.worker?.postMessage({ type: 'stop' });
    this.worker?.terminate();
    this.worker = null;
  }
}
