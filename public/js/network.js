// Network impairment simulator used on the SENDER side (guest) so impairments
// are real: packets are delayed, dropped, duplicated and reordered before they
// reach the WebSocket. The host only ever sees the resulting arrivals.
//
// Everything is driven by an injected RNG and explicit timestamps, which makes
// the unit tests deterministic and lets the same model run in a browser and in
// Node.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand) {
  // Box-Muller, clamped to avoid absurd tails.
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-4, Math.min(4, n));
}

/**
 * Profile is:
 *   baseMs       constant one-way delay
 *   jitterMs     std-dev of Gaussian delay variation
 *   lossPct      independent loss probability
 *   reorderPct   probability of an extra reorder delay of 20-160 ms
 *   dupPct       probability of duplicating the packet 5-40 ms later
 *   burst        { everyMs, lengthMs, extraMs } optional periodic spike
 *   step         { atMs, extraMs } optional one-shot delay step
 *   wobble       { periodMs, amplitudeMs } optional slow sinusoidal drift
 *   seed         RNG seed for reproducibility
 */
export class NetworkImpairment {
  constructor(profile) {
    this.profile = profile;
    this.rand = mulberry32(profile.seed ?? 1);
    this.startedAtMs = null;
    this.sent = 0;
    this.dropped = 0;
    this.duplicated = 0;
    this.reordered = 0;
    this.maxDelayMs = 0;
  }

  reset(seed) {
    if (seed !== undefined) this.profile = { ...this.profile, seed };
    this.rand = mulberry32(this.profile.seed ?? 1);
    this.startedAtMs = null;
    this.sent = 0;
    this.dropped = 0;
    this.duplicated = 0;
    this.reordered = 0;
    this.maxDelayMs = 0;
  }

  _baseDelayMs(elapsedMs) {
    const p = this.profile;
    let delay = p.baseMs ?? 0;
    if (p.wobble) {
      delay += (p.wobble.amplitudeMs ?? 0) * Math.sin((2 * Math.PI * elapsedMs) / (p.wobble.periodMs ?? 10000));
    }
    if (p.step && elapsedMs >= (p.step.atMs ?? Infinity)) delay += p.step.extraMs ?? 0;
    if (p.burst && p.burst.everyMs > 0) {
      const phase = elapsedMs % p.burst.everyMs;
      if (phase < (p.burst.lengthMs ?? 0)) delay += p.burst.extraMs ?? 0;
    }
    return delay;
  }

  /**
   * Decide the fate of one packet.
   * Returns { deliver: Array<{atMs, duplicate:boolean}>, dropped:boolean }.
   * atMs is a sender-local monotonic timestamp when the packet should be sent.
   */
  plan(nowMs) {
    if (this.startedAtMs === null) this.startedAtMs = nowMs;
    const elapsed = nowMs - this.startedAtMs;
    const p = this.profile;
    this.sent++;
    if ((p.lossPct ?? 0) > 0 && this.rand() * 100 < p.lossPct) {
      this.dropped++;
      return { deliver: [], dropped: true };
    }
    let delay = Math.max(0, this._baseDelayMs(elapsed) + gaussian(this.rand) * (p.jitterMs ?? 0));
    let reordered = false;
    if ((p.reorderPct ?? 0) > 0 && this.rand() * 100 < p.reorderPct) {
      delay += 20 + this.rand() * 140;
      reordered = true;
      this.reordered++;
    }
    this.maxDelayMs = Math.max(this.maxDelayMs, delay);
    const deliver = [{ atMs: nowMs + delay, duplicate: false }];
    if ((p.dupPct ?? 0) > 0 && this.rand() * 100 < p.dupPct) {
      this.duplicated++;
      deliver.push({ atMs: nowMs + delay + 5 + this.rand() * 35, duplicate: true });
    }
    return { deliver, dropped: false, reordered };
  }

  stats() {
    return {
      sent: this.sent,
      dropped: this.dropped,
      duplicated: this.duplicated,
      reordered: this.reordered,
      lossPct: this.sent ? (this.dropped / this.sent) * 100 : 0,
      maxDelayMs: this.maxDelayMs,
    };
  }
}

// Schedules planned deliveries in a deterministic min-heap by `atMs`. Kept as a
// plain sorted insert because packet rates here are 50/s and the clarity is
// worth more than shaving a log factor.
export class DeliveryQueue {
  constructor() {
    this.items = [];
  }

  push(atMs, payload) {
    const item = { atMs, payload };
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].atMs <= item.atMs) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }

  popDue(nowMs) {
    const out = [];
    while (this.items.length && this.items[0].atMs <= nowMs) {
      out.push(this.heapPop());
    }
    return out;
  }

  heapPop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length === 0) return top;
    this.items[0] = last;
    let i = 0;
    const n = this.items.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.items[l].atMs < this.items[m].atMs) m = l;
      if (r < n && this.items[r].atMs < this.items[m].atMs) m = r;
      if (m === i) break;
      [this.items[m], this.items[i]] = [this.items[i], this.items[m]];
      i = m;
    }
    return top;
  }

  get size() {
    return this.items.length;
  }
}
