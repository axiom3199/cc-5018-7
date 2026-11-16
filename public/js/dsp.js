// Pure, deterministic jitter-buffer and playout logic. No DOM and no timers:
// callers drive time explicitly, so the unit tests can simulate minutes of
// network behaviour in milliseconds.

import { JITTER, clamp, SAMPLE_RATE } from './protocol.js';

// ---------------------------------------------------------------------------
// Arrival statistics. `transit` is (local arrival - sender media timestamp).
// The two clocks have an unknown constant offset, which cancels in differences
// and in the tracked low-water mark, so no clock sync is required for jitter.
// ---------------------------------------------------------------------------
export class ArrivalTracker {
  constructor(alpha = JITTER.EWMA_ALPHA) {
    this.alpha = alpha;
    this.reset();
  }

  reset() {
    this.prevTransit = null;
    this.lowTransit = Infinity;
    this.jitterUs = 0;
    this.samples = 0;
    this.lastArrivalPerfMs = null;
    this.arrivalGapMs = 0;
  }

  observe(mediaStartUs, arrivalPerfMs) {
    const transit = arrivalPerfMs * 1000 - mediaStartUs;
    if (this.prevTransit === null) {
      this.prevTransit = transit;
      this.lowTransit = transit;
      this.samples = 1;
      this.lastArrivalPerfMs = arrivalPerfMs;
      return { jitterMs: 0, excessMs: 0 };
    }
    const d = transit - this.prevTransit;
    this.prevTransit = transit;
    this.jitterUs += this.alpha * (Math.abs(d) - this.jitterUs);
    if (transit < this.lowTransit) this.lowTransit = transit;
    const excess = Math.max(0, transit - this.lowTransit);
    this.arrivalGapMs = this.lastArrivalPerfMs === null ? 0 : arrivalPerfMs - this.lastArrivalPerfMs;
    this.lastArrivalPerfMs = arrivalPerfMs;
    this.samples++;
    return { jitterMs: this.jitterUs / 1000, excessMs: excess / 1000 };
  }

  get jitterMs() {
    return this.jitterUs / 1000;
  }
}

// ---------------------------------------------------------------------------
// Bounded target controller. The target is the amount of programme delay the
// buffer aims to maintain. It is driven ONLY by the smoothed jitter estimate
// and by underrun events, never by individual late packets. Every change is
// rate-limited and the result is clamped to [MIN_MS, MAX_MS], which is what
// prevents "each late packet lengthens the show delay forever".
// ---------------------------------------------------------------------------
export class TargetController {
  constructor(cfg = JITTER, initialMs = JITTER.INITIAL_MS) {
    this.cfg = cfg;
    this.reset(initialMs);
  }

  reset(initialMs = JITTER.INITIAL_MS) {
    this.targetMs = clamp(initialMs, this.cfg.MIN_MS, this.cfg.MAX_MS);
    this.lastChangeMs = -Infinity;
    this.lastUnderrunMs = -Infinity;
    this.raiseCount = 0;
    this.lowerCount = 0;
    this.lastReason = 'init';
    this.startedAtMs = null;
    this.minDwellMs = 2000;
  }

  neededMs(jitterMs) {
    return clamp(jitterMs * 2 + 20, this.cfg.MIN_MS, this.cfg.MAX_MS);
  }

  // nowMs: monotonic local clock. queueMs: current buffered audio.
  update(nowMs, jitterMs, queueMs) {
    const c = this.cfg;
    if (this.startedAtMs === null) this.startedAtMs = nowMs;
    const needed = this.neededMs(jitterMs);
    const since = nowMs - this.lastChangeMs;

    if (needed > this.targetMs && this.targetMs < c.MAX_MS && since >= c.RAISE_COOLDOWN_MS) {
      // Always move by exactly one step. Even a pathological jitter estimate
      // cannot shorten programme delay in one jump; reaching the ceiling takes
      // several rate-limited steps, which keeps the show delay stable. The
      // step is taken whenever more headroom is wanted, so the target can
      // still land exactly on the ceiling.
      this.targetMs = Math.min(c.MAX_MS, Math.min(needed, this.targetMs + c.STEP_UP_MS));
      this.lastChangeMs = nowMs;
      this.lastReason = 'jitter-up';
      this.raiseCount++;
      return true;
    }

    if (
      needed < this.targetMs - c.STEP_DOWN_MS &&
      since >= c.STEP_INTERVAL_MS &&
      queueMs > this.targetMs + 40 &&
      nowMs - this.startedAtMs >= this.minDwellMs
    ) {
      // Shrink only after the buffer has been observed for a while and only
      // while the queue is genuinely healthy. This is the "tighten after the
      // network calms down" path, never a reaction to one packet.
      this.targetMs = Math.max(c.MIN_MS, this.targetMs - c.STEP_DOWN_MS);
      this.lastChangeMs = nowMs;
      this.lastReason = 'recover';
      this.lowerCount++;
      return true;
    }
    return false;
  }

  // Explicit starvation event. Rate-limited independently of jitter updates.
  onUnderrun(nowMs) {
    const c = this.cfg;
    if (nowMs - this.lastUnderrunMs < c.UNDERRUN_WINDOW_MS) return false;
    this.lastUnderrunMs = nowMs;
    const next = Math.min(c.MAX_MS, this.targetMs + c.UNDERRUN_RAISE_MS);
    if (next === this.targetMs) return false;
    this.targetMs = next;
    this.lastChangeMs = nowMs;
    this.lastReason = 'underrun';
    this.raiseCount++;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Reorder gate over encoded packets. Packets are handed to the decoder in
// strict sequence order, because Opus is stateful: feeding it out of order
// corrupts every subsequent frame (verified against WebCodecs). A hole is
// bridged only after REPAIR_WAIT_MS or when the gap is larger than the bounded
// concealment window. The resulting events carry the exact missing sequence
// span, so the playout side can conceal that span and resume at the correct
// media position instead of moving the next packet into the hole.
//
// Wire sequence numbers are u32 and wrap. All comparisons here are modular:
// a packet is "behind" the cursor only when its forward distance from the
// cursor is >= 2^31, so the wrap point itself is not a cliff. Frame events
// carry `unwrappedSeq`, a monotonic media sequence the playout timeline can
// multiply by the frame length without ever jumping backwards.
// ---------------------------------------------------------------------------
const SEQ_HALF = 0x80000000; // 2^31

// Forward distance from `from` to `to` in the u32 sequence space, in
// [0, 2^32). `>>> 0` performs the mod-2^32 reduction.
export function seqForwardDistance(from, to) {
  return (to - from) >>> 0;
}

export class PacketGate {
  constructor(cfg = JITTER) {
    this.cfg = cfg;
    this.reset();
  }

  reset(nextSeq = null) {
    this.nextSeq = nextSeq === null ? null : nextSeq >>> 0;
    this.unwrappedNext = this.nextSeq;
    this.waitStartMs = null;
    this.pending = new Map();
    this.recentSeqs = new Uint32Array(1024);
    this.recentCount = 0;
    this.stats = {
      packets: 0,
      duplicates: 0,
      late: 0,
      reordered: 0,
      gaps: 0,
      gapFrames: 0,
      resyncs: 0,
    };
  }

  _remember(seq) {
    this.recentSeqs[this.recentCount & 1023] = seq;
    this.recentCount++;
  }

  _wasDelivered(seq) {
    const n = Math.min(this.recentCount, 1024);
    for (let i = 0; i < n; i++) {
      if (this.recentSeqs[i] === seq) return true;
    }
    return false;
  }

  push(seq, item, nowMs) {
    this.stats.packets++;
    seq = seq >>> 0;
    if (this.nextSeq === null) {
      this.nextSeq = seq;
      this.unwrappedNext = seq;
    }
    const fwd = seqForwardDistance(this.nextSeq, seq);
    if (fwd >= SEQ_HALF) {
      // Behind the playout cursor. Distinguish a duplicate (re-sent, already
      // played) from a genuinely late packet (first copy arrived after its
      // playout deadline passed).
      if (this._wasDelivered(seq)) this.stats.duplicates++;
      else this.stats.late++;
      return [];
    }
    if (this.pending.has(seq)) {
      this.stats.duplicates++;
      return [];
    }
    if (fwd > 0) this.stats.reordered++;
    this.pending.set(seq, item);
    return this._drain(nowMs);
  }

  poll(nowMs) {
    return this._drain(nowMs);
  }

  _drain(nowMs) {
    const events = [];
    while (this.nextSeq !== null && !this.pending.has(this.nextSeq)) {
      // The nearest pending packet in forward distance. Numeric order alone
      // would pick a packet on the wrong side of the wrap.
      let nextPending = -1;
      let bestDist = SEQ_HALF * 2;
      for (const k of this.pending.keys()) {
        const d = seqForwardDistance(this.nextSeq, k);
        if (d < bestDist) {
          bestDist = d;
          nextPending = k;
        }
      }
      const missing = nextPending < 0 ? 1 : bestDist;

      // A jump beyond the concealment window is a media-period discontinuity,
      // not loss. Announce it immediately; holding it would only add delay.
      if (nextPending >= 0 && missing > this.cfg.MAX_GAP_FRAMES) {
        this.stats.resyncs++;
        events.push({ type: 'resync', fromSeq: this.nextSeq, toSeq: nextPending });
        this.nextSeq = nextPending;
        this.unwrappedNext += missing;
        this.waitStartMs = null;
        continue;
      }

      if (this.waitStartMs === null) this.waitStartMs = nowMs;
      const waited = nowMs - this.waitStartMs;
      const buffered = this.pending.size;
      if (waited < this.cfg.REPAIR_WAIT_MS && buffered <= this.cfg.MAX_GAP_FRAMES) break;

      this.stats.gaps++;
      this.stats.gapFrames += missing;
      events.push({ type: 'gap', startSeq: this.nextSeq, count: missing });
      this.nextSeq = (this.nextSeq + missing) >>> 0;
      this.unwrappedNext += missing;
      this.waitStartMs = null;
      for (const k of [...this.pending.keys()]) {
        if (seqForwardDistance(this.nextSeq, k) >= SEQ_HALF) {
          this.pending.delete(k);
          this.stats.late++;
        }
      }
    }

    while (this.pending.has(this.nextSeq)) {
      const item = this.pending.get(this.nextSeq);
      this.pending.delete(this.nextSeq);
      this._remember(this.nextSeq);
      events.push({ type: 'frame', seq: this.nextSeq, unwrappedSeq: this.unwrappedNext, item });
      this.nextSeq = (this.nextSeq + 1) >>> 0;
      this.unwrappedNext++;
      this.waitStartMs = null;
    }
    return events;
  }

  get queued() {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// Drift controller. Error = actual occupancy - target. Positive error means we
// are holding too much delay, so future media is mapped into slightly fewer
// device samples (ratio < 1); negative means stretch. The ratio is clamped to
// +/- MAX_RATIO, so clock mismatch is absorbed by inaudible time scaling, not
// by periodically dropping whole chunks.
// ---------------------------------------------------------------------------
export class DriftController {
  constructor(cfg = JITTER) {
    this.cfg = cfg;
    this.ratio = 1;
  }

  update(occupancyMs, targetMs) {
    const error = occupancyMs - targetMs;
    const raw = 1 - this.cfg.DRIFT_GAIN_PER_MS * error;
    const min = 1 - this.cfg.DRIFT_MAX_RATIO;
    const max = 1 + this.cfg.DRIFT_MAX_RATIO;
    this.ratio = clamp(raw, min, max);
    return this.ratio;
  }

  reset() {
    this.ratio = 1;
  }
}

// Resample one decoded frame by `ratio`. Linear interpolation is deliberate:
// cheap, deterministic and testable; at +/-2 % the artefacts are far below
// programme material and far less audible than a dropped chunk.
export function resampleFrame(input, ratio) {
  if (Math.abs(ratio - 1) < 1e-9) return input;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  const step = input.length / outLen;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] ?? 0;
    const b = input[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// Explicit concealment for a missing span: fade the last good sample to silence
// over one frame, then stay silent. The span keeps its own timeline length, so
// the following packet is never shifted into it.
export function concealmentSpan(lastPcm, frames, frameSamples = 960) {
  const total = frames * frameSamples;
  const out = new Float32Array(total);
  if (!lastPcm || lastPcm.length === 0) return out;
  const last = lastPcm[lastPcm.length - 1];
  const fadeLen = Math.min(total, frameSamples);
  for (let i = 0; i < fadeLen; i++) out[i] = last * (1 - (i + 1) / fadeLen);
  return out;
}

// Classify where a decoded frame belongs relative to the media cursor. This is
// the single rule that prevents a hole from being filled with later audio:
//   epoch   first frame defines the timeline
//   place   exactly the next frame
//   conceal the frame is later: write explicit concealment of exactly
//           deltaFrames before writing this frame at its own position
//   rebase  the jump is too large to be loss; start a new media period
//   drop    duplicate/overlap; never rewind the timeline
export function classifyPlacement(mediaCursorSamples, frameMediaSample, frameSamples, maxGapFrames) {
  if (mediaCursorSamples == null) return { mode: 'epoch', deltaFrames: 0 };
  const raw = (frameMediaSample - mediaCursorSamples) / frameSamples;
  // More than a quarter frame early cannot be frame rounding: it is a
  // duplicate or overlapping timestamp and must not rewind the timeline.
  if (raw < -0.25) return { mode: 'drop', deltaFrames: Math.round(raw) || 0 };
  const deltaFrames = Math.round(raw);
  if (deltaFrames > maxGapFrames) return { mode: 'rebase', deltaFrames };
  if (deltaFrames > 0) return { mode: 'conceal', deltaFrames };
  return { mode: 'place', deltaFrames: 0 };
}

// ---------------------------------------------------------------------------
// Playout timeline. Owns the media cursor and the last played frame, and turns
// each decoded frame into an explicit decision: where it lands, what
// concealment (if any) precedes it, and which audio the concealment is built
// from. Concealment always fades from the last frame that was actually
// played — never from the post-hole frame and never from a dropped one.
// ---------------------------------------------------------------------------
export class PlayoutTimeline {
  constructor(maxGapFrames = JITTER.MAX_GAP_FRAMES) {
    this.maxGapFrames = maxGapFrames;
    this.cursorSamples = null;
    this.lastPcm = null;
  }

  reset() {
    this.cursorSamples = null;
    this.lastPcm = null;
  }

  // A media-period discontinuity: the next frame starts a fresh timeline at
  // its own position (or, with a sample position, right after it).
  rebase(mediaSample = null) {
    this.cursorSamples = mediaSample;
    this.lastPcm = null;
  }

  // Decide where a decoded frame belongs. Returns one of:
  //   { mode: 'epoch'|'place', at }            write the frame at `at`
  //   { mode: 'conceal', at, concealFrames, concealPcm }  conceal exactly
  //                                           `concealFrames`, then write the
  //                                           frame at its own position
  //   { mode: 'rebase', deltaFrames }         discontinuity; caller rebases
  //   { mode: 'drop', deltaFrames }           overlap; never rewinds
  // `at` is the media-cursor position at which the frame itself is written.
  accept(mediaSample, pcm) {
    const frames = pcm.length;
    if (this.cursorSamples === null) {
      const at = mediaSample;
      this.cursorSamples = mediaSample + frames;
      this.lastPcm = pcm;
      return { mode: 'epoch', at };
    }
    const placement = classifyPlacement(this.cursorSamples, mediaSample, frames, this.maxGapFrames);
    if (placement.mode === 'rebase') {
      this.rebase(mediaSample);
      return { mode: 'rebase', deltaFrames: placement.deltaFrames };
    }
    if (placement.mode === 'drop') {
      // Dropped audio was never played: it must not become the concealment
      // source, and the cursor must not move.
      return { mode: 'drop', deltaFrames: placement.deltaFrames };
    }
    let concealPcm = null;
    if (placement.mode === 'conceal') {
      concealPcm = concealmentSpan(this.lastPcm, placement.deltaFrames, frames);
      this.cursorSamples += placement.deltaFrames * frames;
    }
    const at = this.cursorSamples;
    this.cursorSamples += frames;
    this.lastPcm = pcm;
    return { mode: placement.mode, at, concealFrames: placement.deltaFrames, concealPcm };
  }
}

export function samplesToMsFloat(samples) {
  return (samples * 1000) / SAMPLE_RATE;
}

export function msToSamplesFloat(ms) {
  return (ms * SAMPLE_RATE) / 1000;
}
