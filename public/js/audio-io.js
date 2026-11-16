// Main-thread audio I/O adapters. AudioContext and AudioWorkletNode cannot
// exist inside a Worker, so this module owns the actual devices while the
// kernel worker owns all media decisions. The two meet at:
//   - capture: worklet posts exact 960-sample blocks here, forwarded to the
//     kernel for Opus encoding and network scheduling
//   - playout: kernel fills a SharedArrayBuffer ring which the playout worklet
//     reads at the real sound-card clock; this module only starts/monitors it

import { SAMPLE_RATE, CHANNELS } from './protocol.js';

export class GuestAudioIO {
  constructor({ onFrame, onLevel, onReady, onError } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onReady = onReady || (() => {});
    this.onError = onError || (() => {});
    this.ctx = null;
    this.node = null;
    this.stream = null;
    this.sourceNode = null;
    this.speechBuffer = null;
    this.speechNode = null;
    this.source = 'tone';
  }

  async start({ source = 'tone', speechUrl = '/assets/guest-speech.wav', gain = 0.35 } = {}) {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('/worklets/capture-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [CHANNELS],
      processorOptions: { mode: source, gain },
    });
    // Keep the node pulled by the graph without monitoring the local source.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'frame') this.onFrame(m);
      else if (m.type === 'level') this.onLevel(m);
      else if (m.type === 'capture-ready') this.onReady({ captureRate: m.sampleRate, mode: m.mode });
    };

    await this.setSource(source, speechUrl);
    await this.ctx.resume();
    return {
      contextRate: this.ctx.sampleRate,
      captureRate: this.ctx.sampleRate,
      source,
      micLabel: this.stream?.getAudioTracks?.()[0]?.label,
      micSettings: this.stream?.getAudioTracks?.()[0]?.getSettings?.(),
      speechSeconds: this.speechBuffer?.duration,
      speechRate: this.speechBuffer?.sampleRate,
    };
  }

  async setSource(source, speechUrl = '/assets/guest-speech.wav') {
    if (!this.node) return null;
    this.source = source;
    this._disconnectSources();
    if (source === 'mic') {
      await this._enableMic();
      this.node.port.postMessage({ type: 'mode', mode: 'mic' });
    } else if (source === 'speech') {
      await this._enableSpeech(speechUrl);
      this.node.port.postMessage({ type: 'mode', mode: 'speech' });
    } else {
      this.node.port.postMessage({ type: 'mode', mode: source });
    }
    return {
      source,
      micLabel: this.stream?.getAudioTracks?.()[0]?.label,
      micSettings: this.stream?.getAudioTracks?.()[0]?.getSettings?.(),
      speechSeconds: this.speechBuffer?.duration,
      speechRate: this.speechBuffer?.sampleRate,
    };
  }

  async _enableMic() {
    if (!this.stream) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    }
    this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
    this.sourceNode.connect(this.node);
  }

  async _enableSpeech(url) {
    if (!this.speechBuffer) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`speech fetch failed: ${res.status}`);
      const arr = await res.arrayBuffer();
      this.speechBuffer = await this.ctx.decodeAudioData(arr);
    }
    this.speechNode = this.ctx.createBufferSource();
    this.speechNode.buffer = this.speechBuffer;
    this.speechNode.loop = true;
    this.speechNode.connect(this.node);
    this.speechNode.start();
  }

  _disconnectSources() {
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect(this.node);
      } catch {}
      this.sourceNode = null;
    }
    if (this.speechNode) {
      try {
        this.speechNode.disconnect(this.node);
      } catch {}
      try {
        this.speechNode.stop();
      } catch {}
      this.speechNode = null;
    }
  }

  marker(id, label) {
    this.node?.port.postMessage({ type: 'marker', markerId: id, label });
  }

  setGain(gain) {
    this.node?.port.postMessage({ type: 'gain', gain });
  }

  async resume() {
    if (this.ctx?.state !== 'running') await this.ctx?.resume();
  }

  stop() {
    this._disconnectSources();
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.node?.disconnect();
    this.ctx?.close().catch(() => {});
    this.stream = null;
    this.node = null;
    this.ctx = null;
  }
}

export class HostAudioIO {
  constructor({ ringSab, onUnderrun, onReady, onError } = {}) {
    this.ringSab = ringSab;
    this.onUnderrun = onUnderrun || (() => {});
    this.onReady = onReady || (() => {});
    this.onError = onError || (() => {});
    this.ctx = null;
    this.node = null;
    this.monitor = null;
    this.monitorOn = true;
  }

  async start() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('/worklets/playout-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'playout', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [CHANNELS],
      processorOptions: { ringSab: this.ringSab },
    });
    // The monitor gain is the real listen switch. The worklet always produces
    // programme samples so the ring and monitor stay truthful; this gain
    // decides whether the operator hears them.
    this.monitor = this.ctx.createGain();
    this.monitor.gain.value = this.monitorOn ? 1 : 0;
    this.node.connect(this.monitor).connect(this.ctx.destination);
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'underrun') this.onUnderrun(m);
      else if (m.type === 'worklet-ready') this.onReady({ workletRate: m.sampleRate });
    };
    await this.ctx.resume();
    return { contextRate: this.ctx.sampleRate, workletRate: this.ctx.sampleRate };
  }

  setMonitor(on) {
    this.monitorOn = !!on;
    if (this.monitor) this.monitor.gain.value = on ? 1 : 0;
  }

  async resume() {
    if (this.ctx?.state !== 'running') await this.ctx?.resume();
  }

  stop() {
    this.node?.disconnect();
    this.ctx?.close().catch(() => {});
    this.node = null;
    this.ctx = null;
  }
}
