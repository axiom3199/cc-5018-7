// Remote-audio kernel worker.
//
// One worker runs the whole media path, so main-thread jank cannot disturb
// capture or decode timing:
//
//   guest: capture worklet -> Opus encode -> impairment queue -> WebSocket
//   host:  WebSocket -> sequence gate -> Opus decode -> timeline placement
//          -> drift resample -> playout ring -> AudioWorklet
//
// The kernel owns every buffer decision (target, concealment, drift, rebase)
// and reports measurements to the page, which is UI only.

import {
  SAMPLE_RATE,
  FRAME_SAMPLES,
  CHANNELS,
  OPUS_BITRATE,
  JITTER,
  MSG,
  SAB,
  SAB_COMMAND,
  SAB_BYTES,
  RING_SAMPLES,
  RING_MASK,
  RING_BYTE_OFFSET,
  encodeMediaPacket,
  decodeMediaPacket,
  clamp,
  msToSamples,
  samplesToMs,
} from '/js/protocol.js';
import {
  ArrivalTracker,
  TargetController,
  PacketGate,
  PlayoutTimeline,
  DriftController,
  resampleFrame,
} from '/js/dsp.js';
import { NetworkImpairment, DeliveryQueue } from '/js/network.js';

/* global AudioEncoder, AudioDecoder, AudioData, EncodedAudioChunk */

let mode = null;
let ws = null;
let opts = {};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const stats = {
  running: false,
  connected: false,
  period: 0,
  source: 'tone',
  targetMs: JITTER.INITIAL_MS,
  manualBiasMs: 0,
  jitterMs: 0,
  excessMs: 0,
  occupancyMs: 0,
  rms: 0,
  peak: 0,
  e2eLatencyMs: 0,
  maxE2eLatencyMs: 0,
  packetsSent: 0,
  packetsReceived: 0,
  bytesSent: 0,
  bytesReceived: 0,
  framesCaptured: 0,
  framesEncoded: 0,
  framesDecoded: 0,
  framesWritten: 0,
  samplesPlayed: 0,
  underruns: 0,
  gaps: 0,
  gapFrames: 0,
  concealedSamples: 0,
  resyncs: 0,
  duplicates: 0,
  late: 0,
  reordered: 0,
  maxMissingRunFrames: 0,
  encodeErrors: 0,
  decodeErrors: 0,
  driftRatio: 1,
  driftCorrections: 0,
  overflows: 0,
  lastRepairReason: '',
  lastSourceState: '',
  inputRate: SAMPLE_RATE,
  markersSent: 0,
  markersReceived: 0,
  markersMeasured: 0,
  markerLatenciesMs: [],
  impairment: null,
  negotiation: {},
};

let ringSab = null;
let ctrl = null;
let ring = null;

let encoder = null;
let decoder = null;
let nextEncodeSeq = 0;
let seqToSampleStart = new Map();

let impairment = null;
let deliveryQueue = new DeliveryQueue();
let planTimer = null;

let gate = null;
let arrivals = null;
let targets = null;
let drift = null;

// Timeline placement (media cursor + concealment source) lives in one pure
// object so the unit tests drive the exact same output-advance logic.
let timeline = null;
let placementDrops = 0;
const decodeFifo = [];

let paused = false;
let pendingRemoteMarkers = new Map(); // mediaStartUs -> marker record
let lastStatsPushMs = 0;
let statsTimer = null;
let queueTimer = null;
let generation = 0;
let eventLog = [];

function logEvent(kind, detail) {
  eventLog.push({ at: Math.round(performance.now()), kind, detail });
  if (eventLog.length > 200) eventLog.shift();
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------
function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function wsSendJson(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function wsSendBinary(buf) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(buf);
    stats.packetsSent++;
    stats.bytesSent += buf.byteLength;
    return true;
  }
  return false;
}

function connect(o) {
  const base = o.url || `${self.location.protocol === 'https:' ? 'wss' : 'ws'}://${self.location.host}/ws`;
  ws = new WebSocket(base);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    stats.connected = true;
    wsSendJson({
      type: MSG.HELLO,
      version: 2,
      role: mode,
      session: o.session || 'studio',
      name: o.name || mode,
    });
    post('ws-open', {});
  };
  ws.onclose = () => {
    stats.connected = false;
    post('ws-close', {});
  };
  ws.onerror = () => post('ws-error', {});
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      onWsJson(msg);
    } else if (mode === 'host') {
      onMedia(e.data);
    }
  };
}

// ---------------------------------------------------------------------------
// guest: encode audio blocks forwarded by the page's capture worklet
// ---------------------------------------------------------------------------
async function startGuest(o) {
  opts = { ...opts, ...o };
  mode = 'guest';
  stats.source = o.source || 'tone';
  stats.reportedSampleRate = o.sampleRate || SAMPLE_RATE;

  await setupEncoder(o);

  impairment = new NetworkImpairment({
    baseMs: 0,
    jitterMs: 0,
    lossPct: 0,
    reorderPct: 0,
    dupPct: 0,
    seed: Date.now() & 0xffff,
    ...(o.profile || {}),
  });
  stats.impairment = impairment.stats();
  stats.running = true;
  statsTimer = setInterval(() => {
    post('stats', { stats: snapshot() });
    wsSendJson({ type: MSG.STATS, role: 'guest', ...snapshotForWire() });
  }, 250);
  logEvent('guest-start', { source: stats.source });
  post('state', { running: true, mode, stats: snapshot() });
  post('negotiation', stats.negotiation);
}

async function setupEncoder(o) {
  const support = await AudioEncoder.isConfigSupported({
    codec: 'opus',
    sampleRate: SAMPLE_RATE,
    numberOfChannels: CHANNELS,
    bitrate: o.bitrate || OPUS_BITRATE,
  });
  stats.negotiation.opusEncoder = !!support.supported;
  if (!support.supported) throw new Error('Opus encoder unsupported in this browser');
  encoder = new AudioEncoder({
    output: onEncoded,
    error: (err) => {
      stats.encodeErrors++;
      post('error', { message: `encoder: ${err.message || err}` });
    },
  });
  encoder.configure({
    codec: 'opus',
    sampleRate: SAMPLE_RATE,
    numberOfChannels: CHANNELS,
    bitrate: o.bitrate || OPUS_BITRATE,
  });
}

// Called from the page for every 960-sample capture block. The page owns the
// sound card; the kernel owns encoding and the send timeline.
function onCaptureFrame(m) {
  if (!encoder || encoder.state !== 'configured') {
    post('error', { message: 'capture frame arrived before encoder was ready' });
    return;
  }
  const pcm = new Float32Array(m.pcm);
  stats.framesCaptured++;
  if (m.marker) {
    seqToSampleStart.set(nextEncodeSeq + encoder.encodeQueueSize, {
      markerId: m.marker.markerId,
      label: m.marker.label,
      sampleStart: m.sampleStart,
    });
  }
  const data = new AudioData({
    format: 'f32-planar',
    sampleRate: SAMPLE_RATE,
    numberOfFrames: FRAME_SAMPLES,
    numberOfChannels: CHANNELS,
    timestamp: Math.round((m.sampleStart / SAMPLE_RATE) * 1e6),
    data: pcm,
  });
  encoder.encode(data);
  data.close();
}

function onEncoded(chunk) {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  const seq = nextEncodeSeq++;
  const mediaStartUs = chunk.timestamp;
  stats.framesEncoded++;

  const markerInfo = seqToSampleStart.get(seq);
  if (markerInfo) {
    seqToSampleStart.delete(seq);
    wsSendJson({
      type: MSG.MARKER,
      // The host matches markers against the wire sequence number, so send
      // the same u32 the media packet carries, not the unwrapped counter.
      seq: seq >>> 0,
      mediaStartUs,
      wallEpochMs: performance.timeOrigin + performance.now(),
      markerId: markerInfo.markerId,
      label: markerInfo.label,
    });
  }
  // Keep the map bounded even if markers were dropped by impairment.
  if (seqToSampleStart.size > 300) {
    for (const k of seqToSampleStart.keys()) if (k < seq - 150) seqToSampleStart.delete(k);
  }

  const packet = encodeMediaPacket(seq, mediaStartUs, bytes);
  if (impairment) {
    const plan = impairment.plan(performance.now());
    if (!plan.dropped) {
      for (const d of plan.deliver) deliveryQueue.push(d.atMs, packet);
    }
    stats.impairment = impairment.stats();
    ensurePlanTimer();
  } else {
    wsSendBinary(packet);
  }
}

function ensurePlanTimer() {
  if (planTimer !== null) return;
  planTimer = setInterval(flushPlanned, 4);
}

function flushPlanned() {
  if (deliveryQueue.size === 0) {
    clearInterval(planTimer);
    planTimer = null;
    return;
  }
  for (const item of deliveryQueue.popDue(performance.now())) {
    wsSendBinary(item.payload);
  }
}

// ---------------------------------------------------------------------------
// host: receive, gate, decode, timeline placement
// ---------------------------------------------------------------------------
async function startHost(o) {
  opts = { ...opts, ...o };
  mode = 'host';
  ringSab = o.ringSab || new SharedArrayBuffer(SAB_BYTES);
  ctrl = new Int32Array(ringSab, 0, SAB.INT_SLOTS);
  ring = new Float32Array(ringSab, RING_BYTE_OFFSET, RING_SAMPLES);

  await setupDecoder();
  gate = new PacketGate();
  arrivals = new ArrivalTracker();
  targets = new TargetController();
  drift = new DriftController();
  timeline = new PlayoutTimeline();
  placementDrops = 0;

  Atomics.store(ctrl, SAB.WRITE_SAMPLE, 0);
  Atomics.store(ctrl, SAB.READ_SAMPLE, 0);
  Atomics.store(ctrl, SAB.PLAYING, 0);
  Atomics.store(ctrl, SAB.TARGET_SAMPLES, msToSamples(JITTER.INITIAL_MS));
  Atomics.store(ctrl, SAB.DEVICE_SKEW_PPM, clamp(o.deviceSkewPpm ?? 0, -50000, 50000));
  Atomics.store(ctrl, SAB.MON_ENABLE, 1);
  Atomics.store(ctrl, SAB.COMMAND, SAB_COMMAND.NONE);

  if (o.deviceSkewPpm) {
    stats.negotiation.deviceSkew = `${(o.deviceSkewPpm / 1e4).toFixed(2)} % (${o.deviceSkewPpm} ppm)`;
  }

  stats.running = true;
  queueTimer = setInterval(queueTick, 10);
  post('ring-ready', { ringSab, ringLength: RING_SAMPLES, ringOffset: RING_BYTE_OFFSET });
  post('state', { running: true, mode, stats: snapshot() });
  post('negotiation', stats.negotiation);
  logEvent('host-start', { sampleRate: SAMPLE_RATE });
}

async function setupDecoder() {
  const support = await AudioDecoder.isConfigSupported({
    codec: 'opus',
    sampleRate: SAMPLE_RATE,
    numberOfChannels: CHANNELS,
  });
  stats.negotiation.opusDecoder = !!support.supported;
  if (!support.supported) throw new Error('Opus decoder unsupported in this browser');
  decoder = new AudioDecoder({
    output: onDecoded,
    error: (err) => {
      stats.decodeErrors++;
      post('error', { message: `decoder: ${err.message || err}` });
    },
  });
  decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS });
}

function onMedia(arrayBuffer) {
  const pkt = decodeMediaPacket(arrayBuffer);
  if (!pkt) {
    stats.decodeErrors++;
    return;
  }
  stats.packetsReceived++;
  stats.bytesReceived += arrayBuffer.byteLength;
  stats.lastWireSeq = pkt.seq;
  const arrivalMs = performance.now();
  const obs = arrivals.observe(pkt.mediaStartUs, arrivalMs);
  stats.jitterMs = obs.jitterMs;
  stats.excessMs = obs.excessMs;

  const lateBefore = gate.stats.late;
  const events = gate.push(pkt.seq, pkt, arrivalMs);
  if (gate.stats.late > lateBefore) {
    // A first-copy packet that missed its playout deadline. Logged with its
    // sequence number so the event log (and the timing regression) can tell
    // a genuinely late packet apart from a wrap or resync artefact.
    logEvent('late-packet', { seq: pkt.seq });
  }
  for (const ev of events) {
    if (ev.type === 'frame') {
      decodePacket(ev.item, ev.unwrappedSeq);
    } else if (ev.type === 'gap') {
      // Do not count here: the decoder timestamps give the authoritative gap
      // size, and counting both places would double-report loss. This is
      // telemetry only, used to explain why a hole appeared.
      logEvent('gate-gap', { startSeq: ev.startSeq, count: ev.count });
    } else if (ev.type === 'resync') {
      // Likewise, the rebase happens when the next decoded timestamp proves a
      // discontinuity; gate-level resync just skips sequence numbers.
      logEvent('gate-resync', { fromSeq: ev.fromSeq, toSeq: ev.toSeq });
    }
  }
  stats.duplicates = gate.stats.duplicates;
  stats.late = gate.stats.late + placementDrops;
  stats.reordered = gate.stats.reordered;
}

function decodePacket(pkt, unwrappedSeq) {
  if (decoder.state !== 'configured') return;
  if (decoder.decodeQueueSize > 50) {
    // Bounded decode: refuse to accumulate unbounded work. Counted as loss.
    stats.decodeErrors++;
    logEvent('decode-overflow', { seq: pkt.seq, queued: decoder.decodeQueueSize });
    return;
  }
  // WebCodecs Opus output timestamps are an internal continuous count and do
  // NOT reflect skipped input timestamps (verified experimentally). The media
  // sequence number is therefore the only reliable timeline anchor; pair it
  // with the decoder output through a FIFO, because decode is asynchronous but
  // strictly ordered. The gate's unwrapped sequence keeps the anchor monotonic
  // across the u32 wire wrap.
  pkt.unwrappedSeq = unwrappedSeq;
  decodeFifo.push(pkt);
  if (decodeFifo.length > 200) decodeFifo.shift();
  decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: pkt.mediaStartUs, data: pkt.payload }));
}

function onDecoded(data) {
  const frames = data.numberOfFrames;
  const tsUs = data.timestamp;
  const pcm = new Float32Array(frames);
  data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
  data.close();
  stats.framesDecoded++;
  stats.framesWritten++;

  // Match this decoded output to the packet that produced it. Sequence
  // numbers, not output timestamps, define the media timeline.
  const pkt = decodeFifo.shift();
  const seq = pkt ? pkt.seq : null;
  const mediaSample = pkt ? pkt.unwrappedSeq * FRAME_SAMPLES : Math.round((tsUs / 1e6) * SAMPLE_RATE);

  const r = timeline.accept(mediaSample, pcm);
  if (r.mode === 'epoch') {
    logEvent('media-epoch', { seq, mediaSample });
  } else if (r.mode === 'rebase') {
    // Media discontinuity: never conceal hundreds of frames. Flush the ring
    // and resume at the new position; the silence is explicit and reported.
    rebasePlayout(mediaSample, 'timestamp-jump', r.deltaFrames);
    return;
  } else if (r.mode === 'drop') {
    // Overlapping/duplicate media: drop it rather than rewind the timeline.
    logEvent('drop-overlap', { frames: r.deltaFrames });
    placementDrops++;
    stats.late = gate.stats.late + placementDrops;
    return;
  } else if (r.mode === 'conceal') {
    // Explicit concealment exactly where the missing media belongs, built from
    // the last frame that was actually played. The next frame is then written
    // after it, at its own media position.
    writeSpan(r.concealPcm, r.concealFrames);
    stats.gaps++;
    stats.gapFrames += r.concealFrames;
    stats.concealedSamples += r.concealFrames * FRAME_SAMPLES;
    stats.lastRepairReason = gate?.stats.late ? 'late-arrival' : 'packet-loss';
    logEvent('conceal', { frames: r.concealFrames, reason: stats.lastRepairReason });
    post('conceal', { frames: r.concealFrames, reason: stats.lastRepairReason });
  }

  writeSpan(pcm, 1);

  const marker = seq == null ? null : pendingRemoteMarkers.get(seq);
  if (marker) {
    pendingRemoteMarkers.delete(seq);
    marker.decodedAtMs = performance.now();
    marker.bufferedAheadSamples = Math.max(
      0,
      (Atomics.load(ctrl, SAB.WRITE_SAMPLE) >>> 0) - (Atomics.load(ctrl, SAB.READ_SAMPLE) >>> 0),
    );
    marker.bufferedMs = samplesToMs(marker.bufferedAheadSamples);
    stats.markersReceived++;
    post('marker-decoded', { markerId: marker.markerId, bufferedMs: marker.bufferedMs });
  }
}

// Append one media frame (or a concealment span) to the ring, applying the
// drift ratio. `mediaFrames` is how many 20 ms media frames this span stands
// for; the media cursor is advanced by the caller.
function writeSpan(pcm, mediaFrames) {
  const ratio = drift ? drift.ratio : 1;
  const out = resampleFrame(pcm, ratio);
  const write = Atomics.load(ctrl, SAB.WRITE_SAMPLE) >>> 0;
  const read = Atomics.load(ctrl, SAB.READ_SAMPLE) >>> 0;
  const occupancy = write - read;

  // Bounded queue: refuse unbounded programme delay even under a pathological
  // burst. This is an explicit overflow, counted, never silent.
  if (samplesToMs(occupancy) > JITTER.MAX_QUEUE_MS) {
    stats.overflows++;
    logEvent('overflow', { occupancyMs: samplesToMs(occupancy) });
    return;
  }

  for (let i = 0; i < out.length; i++) {
    ring[(write + i) & RING_MASK] = out[i];
  }
  const next = write + out.length;
  Atomics.store(ctrl, SAB.WRITE_SAMPLE, next);
  stats.samplesWritten = (stats.samplesWritten || 0) + out.length;
}

function rebasePlayout(mediaSample, reason, missingFrames) {
  generation++;
  timeline.rebase(mediaSample);
  Atomics.store(ctrl, SAB.PLAYING, 0);
  Atomics.store(ctrl, SAB.COMMAND, SAB_COMMAND.FLUSH);
  paused = true;
  stats.resyncs++;
  stats.lastRepairReason = reason;
  logEvent('rebase', { reason, missingFrames, generation });
  post('rebase', { reason, missingFrames, generation });
}

function onUnderrun() {
  stats.underruns++;
  paused = true;
  Atomics.store(ctrl, SAB.PLAYING, 0);
  if (targets && targets.onUnderrun(performance.now())) {
    stats.targetMs = clamp(targets.targetMs + stats.manualBiasMs, JITTER.MIN_MS, JITTER.MAX_MS);
    Atomics.store(ctrl, SAB.TARGET_SAMPLES, msToSamples(stats.targetMs));
    post('target', { targetMs: stats.targetMs, reason: 'underrun', biasMs: stats.manualBiasMs });
  }
  logEvent('underrun', { count: stats.underruns });
  post('underrun', { count: stats.underruns, targetMs: stats.targetMs });
}

// ---------------------------------------------------------------------------
// 10 ms housekeeping: poll gate, adapt target, drift, start/restart, stats
// ---------------------------------------------------------------------------
function queueTick() {
  if (!ctrl) return;
  const now = performance.now();
  const read = Atomics.load(ctrl, SAB.READ_SAMPLE) >>> 0;
  const write = Atomics.load(ctrl, SAB.WRITE_SAMPLE) >>> 0;
  const occupancy = Math.max(0, write - read);
  const occupancyMs = samplesToMs(occupancy);
  stats.occupancyMs = occupancyMs;
  stats.samplesPlayed = read;

  if (gate) {
    const events = gate.poll(now);
    for (const ev of events) {
      if (ev.type === 'frame') decodePacket(ev.item, ev.unwrappedSeq);
      else if (ev.type === 'gap') logEvent('gate-gap', { startSeq: ev.startSeq, count: ev.count });
      else if (ev.type === 'resync') logEvent('gate-resync', { fromSeq: ev.fromSeq, toSeq: ev.toSeq });
    }
  }

  if (targets) {
    const prev = targets.targetMs;
    targets.update(now, arrivals ? arrivals.jitterMs : 0, occupancyMs);
    stats.targetMs = clamp(targets.targetMs + stats.manualBiasMs, JITTER.MIN_MS, JITTER.MAX_MS);
    Atomics.store(ctrl, SAB.TARGET_SAMPLES, msToSamples(stats.targetMs));
    if (targets.targetMs !== prev) {
      post('target', {
        targetMs: stats.targetMs,
        reason: targets.lastReason,
        biasMs: stats.manualBiasMs,
        jitterMs: stats.jitterMs,
      });
      logEvent('target', { targetMs: stats.targetMs, reason: targets.lastReason });
    }
  }

  if (drift) {
    drift.update(occupancyMs, stats.targetMs);
    stats.driftRatio = drift.ratio;
    Atomics.store(ctrl, SAB.RATIO_PPM, Math.round((drift.ratio - 1) * 1e6));
    if (Math.abs(drift.ratio - 1) > 0.0005) stats.driftCorrections++;
  }

  // Playback starts only once the bounded target is actually queued.
  if (!paused && Atomics.load(ctrl, SAB.PLAYING) === 0) {
    if (occupancyMs >= stats.targetMs + JITTER.START_MARGIN_MS) {
      Atomics.store(ctrl, SAB.PLAYING, 1);
      logEvent('playing', { occupancyMs, targetMs: stats.targetMs });
      post('playing', { targetMs: stats.targetMs, occupancyMs });
    }
  } else if (paused) {
    if (occupancyMs >= stats.targetMs + JITTER.START_MARGIN_MS) paused = false;
  }

  finalizeMarkers(now, occupancyMs);

  if (now - lastStatsPushMs >= 200) {
    lastStatsPushMs = now;
    stats.rms = Atomics.load(ctrl, SAB.RMS) / 10000;
    stats.peak = Atomics.load(ctrl, SAB.PEAK) / 10000;
    stats.underrunsReportedByWorklet = Atomics.load(ctrl, SAB.UNDERRUNS);
    post('stats', { stats: snapshot() });
    wsSendJson({ type: MSG.STATS, role: 'host', ...snapshotForWire() });
  }
}

function finalizeMarkers(now, occupancyMs) {
  if (pendingRemoteMarkers.size === 0) return;
  for (const [us, m] of pendingRemoteMarkers) {
    if (!m.decodedAtMs) continue;
    // Marker was decoded and written; its audio starts about `bufferedMs`
    // behind the current playhead. Add the time already spent since decode.
    const elapsed = now - m.decodedAtMs;
    const latency = Math.max(0, m.bufferedMs - elapsed);
    // Host-side "arrival to playout": concrete, clock-offset-free.
    m.hostBufferLatencyMs = latency;
    m.latencyMs = latency;
    pendingRemoteMarkers.delete(us);
    stats.markersMeasured++;
    stats.markerLatenciesMs.push(latency);
    if (stats.markerLatenciesMs.length > 100) stats.markerLatenciesMs.shift();
    const avg = stats.markerLatenciesMs.reduce((a, b) => a + b, 0) / stats.markerLatenciesMs.length;
    stats.e2eLatencyMs = avg;
    stats.maxE2eLatencyMs = Math.max(stats.maxE2eLatencyMs, latency);
    post('marker', { markerId: m.markerId, bufferLatencyMs: latency, avgMs: avg });
    // Echo back to the guest so it can compute RTT/2 + buffer as an end-to-end
    // estimate without needing synchronized clocks.
    wsSendJson({
      type: MSG.MARKER,
      role: 'host',
      echo: true,
      markerId: m.markerId,
      bufferLatencyMs: latency,
      wallEpochMs: m.wallEpochMs,
    });
  }
}

function onWsJson(msg) {
  switch (msg.type) {
    case MSG.WELCOME:
      stats.period = msg.period;
      stats.connected = true;
      logEvent('welcome', { period: msg.period, peer: msg.peerPresent });
      post('welcome', msg);
      break;
    case MSG.PEER_STATE:
      post('peer-state', msg);
      if (mode === 'host') {
        if (msg.guestConnected === false) handlePeriodEnd('guest-disconnected');
        // Only a genuinely new period triggers a rebase. `stats.period` starts
        // at 0/undefined, so establish it on the first peer-state instead of
        // treating that handshake as a period change.
        if (stats.period == null || stats.period === 0) stats.period = msg.period;
        else if (msg.period !== stats.period) {
          stats.period = msg.period;
          // A new media period is a new sequence space: the old gate would
          // condemn every packet of a restarted sender as "late". Reset it so
          // the new period's packets are eligible again.
          gate = new PacketGate();
          pendingRemoteMarkers.clear();
          rebasePlayout(null, 'new-period', 0);
        }
      }
      break;
    case MSG.START:
      post('start', msg);
      break;
    case MSG.STOP:
      handlePeriodEnd('stopped');
      break;
    case MSG.MARKER:
      if (mode === 'host') handleRemoteMarker(msg);
      else if (msg.echo) handleMarkerEcho(msg);
      break;
    case MSG.FEEDBACK:
      if (mode === 'guest') applyFeedback(msg);
      else post('feedback', msg);
      break;
    case MSG.CONTROL:
      applyControl(msg);
      break;
    case MSG.STATS:
      post('peer-stats', msg);
      break;
    default:
      break;
  }
}

function handleRemoteMarker(msg) {
  stats.markersSent++;
  const rec = {
    markerId: msg.markerId,
    seq: msg.seq,
    mediaStartUs: msg.mediaStartUs,
    wallEpochMs: msg.wallEpochMs,
    arrivedAtMs: performance.now(),
    decodedAtMs: null,
  };
  pendingRemoteMarkers.set(msg.seq, rec);
  if (pendingRemoteMarkers.size > 100) {
    const first = pendingRemoteMarkers.keys().next().value;
    pendingRemoteMarkers.delete(first);
  }
  post('marker-received', { markerId: msg.markerId, seq: msg.seq, mediaStartUs: msg.mediaStartUs });
}

let lastMarkerSentAt = 0;
function handleMarkerEcho(msg) {
  const rtt = performance.now() - lastMarkerSentAt;
  const e2e = rtt / 2 + (msg.bufferLatencyMs || 0);
  stats.e2eLatencyMs = stats.e2eLatencyMs ? stats.e2eLatencyMs * 0.7 + e2e * 0.3 : e2e;
  stats.maxE2eLatencyMs = Math.max(stats.maxE2eLatencyMs, e2e);
  stats.markerLatenciesMs.push(e2e);
  if (stats.markerLatenciesMs.length > 100) stats.markerLatenciesMs.shift();
  post('marker-echo', { markerId: msg.markerId, rttMs: rtt, e2eMs: e2e, bufferMs: msg.bufferLatencyMs });
}

function handlePeriodEnd(reason) {
  if (mode !== 'host') return;
  paused = true;
  timeline.reset();
  Atomics.store(ctrl, SAB.PLAYING, 0);
  logEvent('period-end', { reason });
  post('period-end', { reason });
}

function resetReceive(reason) {
  if (!gate) return;
  gate = new PacketGate();
  pendingRemoteMarkers.clear();
  timeline.reset();
  paused = true;
  stats.jitterMs = 0;
  stats.occupancyMs = 0;
  Atomics.store(ctrl, SAB.PLAYING, 0);
  Atomics.store(ctrl, SAB.COMMAND, SAB_COMMAND.FLUSH);
  logEvent('reset-receive', { reason });
  post('rebase', { reason, generation: ++generation });
}

// ---------------------------------------------------------------------------
// controls and feedback (both directions are live: the page never just draws)
// ---------------------------------------------------------------------------
function applyControl(msg) {
  if (msg.action === 'set-bias') {
    stats.manualBiasMs = clamp(Number(msg.biasMs) || 0, JITTER.TARGET_BIAS_MIN_MS, JITTER.TARGET_BIAS_MAX_MS);
    const base = targets ? targets.targetMs : JITTER.INITIAL_MS;
    stats.targetMs = clamp(base + stats.manualBiasMs, JITTER.MIN_MS, JITTER.MAX_MS);
    if (ctrl) Atomics.store(ctrl, SAB.TARGET_SAMPLES, msToSamples(stats.targetMs));
    post('target', { targetMs: stats.targetMs, reason: 'manual-bias', biasMs: stats.manualBiasMs });
    logEvent('bias', { biasMs: stats.manualBiasMs });
  } else if (msg.action === 'set-skew') {
    const ppm = clamp(Number(msg.ppm) || 0, -50000, 50000);
    if (ctrl) Atomics.store(ctrl, SAB.DEVICE_SKEW_PPM, Math.round(ppm));
    post('skew', { ppm });
    logEvent('skew', { ppm });
  } else if (msg.action === 'force-underrun') {
    if (mode === 'host') {
      Atomics.store(ctrl, SAB.COMMAND, SAB_COMMAND.FLUSH);
      Atomics.store(ctrl, SAB.PLAYING, 0);
      onUnderrun();
    }
  } else if (msg.action === 'reset') {
    resetReceive('manual');
  } else if (msg.action === 'set-profile' && mode === 'guest' && msg.profile) {
    if (!impairment) impairment = new NetworkImpairment({ seed: 1 });
    impairment.profile = { ...impairment.profile, ...msg.profile };
    impairment.reset(msg.profile.seed);
    post('profile', { profile: impairment.profile });
    logEvent('profile', { profile: msg.profile });
  } else if (msg.action === 'set-monitor' || msg.action === 'resume-audio') {
    // Owned by the page's HostAudioIO; the kernel only acknowledges so the UI
    // can show the real device state.
    post('control-ack', { action: msg.action, on: msg.on });
  } else if (msg.action === 'set-source' && mode === 'guest') {
    // The page switches the actual capture source, then tells the kernel which
    // one is live so telemetry and the wire stay truthful.
    stats.source = msg.source;
    post('source', { source: msg.source });
  } else if (msg.action === 'set-next-seq' && mode === 'guest') {
    // Test hook: jump the send sequence close to the u32 wrap so the link's
    // wraparound handling runs on the real encode/wire/decode path.
    nextEncodeSeq = Number(msg.seq) >>> 0;
    logEvent('set-next-seq', { nextEncodeSeq });
    post('control-ack', { action: msg.action, seq: nextEncodeSeq });
  } else if (msg.action === 'set-bitrate' && mode === 'guest' && encoder) {
    const bitrate = clamp(Number(msg.bitrate) || 64000, 16000, 128000);
    encoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate });
    stats.negotiation.bitrate = bitrate;
    post('bitrate', { bitrate });
  } else if (msg.action === 'start-media' && mode === 'guest') {
    post('media-started', {});
  }
  post('control', msg);
}

function applyFeedback(msg) {
  // Feedback from the host's result area drives the guest kernel: network
  // profile changes, source/bitrate changes and marker requests all land here.
  if (msg.kind === 'set-profile' && impairment) {
    impairment.profile = { ...impairment.profile, ...(msg.profile || {}) };
    impairment.reset(msg.profile?.seed);
    stats.impairment = impairment.stats();
    post('profile', { profile: impairment.profile });
    logEvent('feedback-profile', { profile: impairment.profile });
  } else if (msg.kind === 'set-bitrate' && encoder) {
    const bitrate = clamp(Number(msg.bitrate) || 64000, 16000, 128000);
    encoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate });
    stats.negotiation.bitrate = bitrate;
    post('bitrate', { bitrate });
  } else if (msg.kind === 'set-source') {
    stats.source = msg.source;
    post('source', { source: msg.source });
  } else if (msg.kind === 'marker') {
    post('marker-request', { label: msg.label });
  } else if (msg.kind === 'result') {
    // The host's result area feeds real measurements back here: an underrun or
    // concealment event is surfaced on the remote end so the operator there
    // sees the link's actual behaviour, not just a remote chart.
    stats.lastHostResult = { at: Date.now(), ...msg };
    if (msg.event === 'underrun') stats.hostUnderruns = (stats.hostUnderruns || 0) + 1;
    post('host-result', msg);
    logEvent('host-result', { event: msg.event, targetMs: msg.targetMs });
  } else if (msg.kind === 'request-stats') {
    post('stats', { stats: snapshot() });
  }
}

// Marker requests originate in the page capture worklet; the kernel cannot
// reach the device. The page sends the marker into the next capture block.
function requestMarker(label = 'marker') {
  if (mode === 'guest') {
    lastMarkerSentAt = performance.now();
    stats.markersSent++;
    post('marker-request', { label, markerId: `m${Date.now()}` });
  }
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------
function snapshot() {
  return {
    ...stats,
    markerLatenciesMs: stats.markerLatenciesMs.slice(-20),
    impairment: impairment ? impairment.stats() : stats.impairment,
    eventLog: eventLog.slice(-40),
  };
}

function snapshotForWire() {
  return {
    period: stats.period,
    targetMs: stats.targetMs,
    jitterMs: stats.jitterMs,
    occupancyMs: stats.occupancyMs,
    underruns: stats.underruns,
    gaps: stats.gaps,
    resyncs: stats.resyncs,
    concealedSamples: stats.concealedSamples,
    driftRatio: stats.driftRatio,
    packetsReceived: stats.packetsReceived,
    framesDecoded: stats.framesDecoded,
    rms: stats.rms,
    peak: stats.peak,
    e2eLatencyMs: stats.e2eLatencyMs,
    maxE2eLatencyMs: stats.maxE2eLatencyMs,
  };
}

// ---------------------------------------------------------------------------
// command surface
// ---------------------------------------------------------------------------
self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || !msg.type) return;
  try {
    switch (msg.type) {
      case 'init-guest':
        await startGuest(msg.options || {});
        connect(msg.options || {});
        break;
      case 'init-host':
        await startHost(msg.options || {});
        connect(msg.options || {});
        break;
      case 'marker':
        requestMarker(msg.label || 'marker');
        break;
      case 'capture-frame':
        onCaptureFrame(msg);
        break;
      case 'capture-level':
        post('capture-level', { peak: msg.peak, chunkIndex: msg.chunkIndex });
        break;
      case 'capture-ready':
        stats.inputRate = msg.sampleRate;
        stats.negotiation.captureRate = msg.sampleRate;
        post('negotiation', stats.negotiation);
        break;
      case 'audio-ready':
        Object.assign(stats.negotiation, msg.info || {});
        post('negotiation', stats.negotiation);
        break;
      case 'audio-underrun':
        if (mode === 'host') onUnderrun();
        break;
      case 'control':
        applyControl(msg);
        if (mode === 'host') wsSendJson({ type: MSG.CONTROL, ...msg, from: 'host' });
        else if (mode === 'guest') wsSendJson({ type: MSG.CONTROL, ...msg, from: 'guest' });
        break;
      case 'feedback':
        wsSendJson({ type: MSG.FEEDBACK, ...msg, from: mode });
        if (mode === 'guest') applyFeedback(msg);
        break;
      case 'get-stats':
        post('stats', { stats: snapshot() });
        break;
      case 'simulate': {
        const result = runSimulation(msg.params || {});
        post('simulation', { result });
        break;
      }
      case 'reconnect':
        if (ws) ws.close();
        connect({ ...opts, ...(msg.options || {}) });
        break;
      case 'disconnect':
        if (ws) ws.close();
        break;
      case 'stop':
        cleanup();
        break;
      default:
        post('error', { message: `unknown command ${msg.type}` });
    }
  } catch (err) {
    post('error', { message: String(err?.message || err) });
  }
};

function cleanup() {
  if (queueTimer) clearInterval(queueTimer);
  if (statsTimer) clearInterval(statsTimer);
  if (planTimer) clearInterval(planTimer);
  if (ws) ws.close();
  post('state', { running: false, mode });
}

// ---------------------------------------------------------------------------
// Offline simulation of the SAME buffer classes. Used by the in-page test
// panel to inject jitter models and produce statistics without a live peer.
// ---------------------------------------------------------------------------
function runSimulation(params) {
  const seconds = params.seconds ?? 60;
  const profile = params.profile || {
    baseMs: 70,
    jitterMs: 20,
    lossPct: 0.5,
    reorderPct: 1,
    dupPct: 0,
    seed: 1,
  };
  const imp = new NetworkImpairment(profile);
  const arrived = [];
  const totalPackets = Math.floor(seconds * 50);
  for (let seq = 0; seq < totalPackets; seq++) {
    const plan = imp.plan(seq * 20);
    for (const d of plan.deliver) arrived.push({ seq, atMs: d.atMs, duplicate: d.duplicate });
  }
  arrived.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);

  const g = new PacketGate();
  const arrival = new ArrivalTracker();
  const target = new TargetController();
  const dr = new DriftController();
  let queueMs = 0;
  let playedMs = 0;
  let underruns = 0;
  let concealedFrames = 0;
  let index = 0;
  let lastTick = -1;
  const timeline = [];
  const startCounter = { on: 0 };
  let playing = false;
  let targetMax = target.targetMs;
  let targetMin = target.targetMs;

  for (let t = 0; t <= seconds * 1000; t += 10) {
    while (index < arrived.length && arrived[index].atMs <= t) {
      const p = arrived[index++];
      arrival.observe(p.seq * 20000, p.atMs);
      for (const ev of g.push(p.seq, p, t)) {
        if (ev.type === 'frame') queueMs += 20;
        else if (ev.type === 'gap') concealedFrames += ev.count;
        else if (ev.type === 'resync') concealedFrames += ev.toSeq - ev.fromSeq;
      }
    }
    for (const ev of g.poll(t)) {
      if (ev.type === 'frame') queueMs += 20;
      else if (ev.type === 'gap') concealedFrames += ev.count;
      else if (ev.type === 'resync') concealedFrames += ev.toSeq - ev.fromSeq;
    }

    const changed = target.update(t, arrival.jitterMs, queueMs);
    if (changed) {
      startCounter.on++;
      targetMax = Math.max(targetMax, target.targetMs);
      targetMin = Math.min(targetMin, target.targetMs);
    }
    dr.update(queueMs, target.targetMs);

    if (!playing && queueMs >= target.targetMs + JITTER.START_MARGIN_MS) playing = true;
    if (playing) {
      const consumed = 10 * dr.ratio;
      if (queueMs < consumed) {
        underruns++;
        queueMs = 0;
        playing = false;
      } else {
        queueMs -= consumed;
        playedMs += consumed;
      }
    }
    if (t - lastTick >= 200) {
      lastTick = t;
      timeline.push({
        t,
        queueMs: +queueMs.toFixed(2),
        targetMs: +target.targetMs.toFixed(2),
        jitterMs: +arrival.jitterMs.toFixed(2),
        ratio: +dr.ratio.toFixed(5),
      });
    }
  }

  const sentStats = imp.stats();
  return {
    profile,
    seconds,
    sentPackets: totalPackets,
    deliveredPackets: arrived.length,
    dropped: sentStats.dropped,
    duplicated: sentStats.duplicated,
    reordered: sentStats.reordered,
    lossPct: sentStats.lossPct,
    underruns,
    gaps: g.stats.gaps,
    resyncs: g.stats.resyncs,
    concealedFrames,
    concealedMs: concealedFrames * 20,
    late: g.stats.late,
    duplicates: g.stats.duplicates,
    finalTargetMs: target.targetMs,
    minTargetMs: targetMin,
    maxTargetMs: targetMax,
    targetChanges: startCounter.on,
    playedMs: Math.round(playedMs),
    timeline,
  };
}
