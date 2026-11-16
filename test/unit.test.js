import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JITTER, FRAME_SAMPLES } from '../public/js/protocol.js';
import {
  ArrivalTracker,
  TargetController,
  PacketGate,
  PlayoutTimeline,
  DriftController,
  resampleFrame,
  concealmentSpan,
  classifyPlacement,
  seqForwardDistance,
} from '../public/js/dsp.js';
import { NetworkImpairment, DeliveryQueue, mulberry32 } from '../public/js/network.js';

test('target controller stays within bounds under minutes of heavy jitter', () => {
  const ctl = new TargetController();
  const rand = mulberry32(7);
  let max = 0;
  let min = Infinity;
  for (let t = 0; t < 10 * 60 * 1000; t += 20) {
    // Smoothed jitter varying between 5 and 300 ms, including pathological
    // spikes. Never more than one change per update.
    const jitter = 5 + Math.abs(Math.sin(t / 7000)) * 295 + (rand() < 0.01 ? 500 : 0);
    const before = ctl.targetMs;
    ctl.update(t, jitter, 150);
    assert.ok(ctl.targetMs <= JITTER.MAX_MS);
    assert.ok(ctl.targetMs >= JITTER.MIN_MS);
    // Never more than one step per update (allow float rounding noise).
    assert.ok(
      Math.abs(ctl.targetMs - before) <= Math.max(JITTER.STEP_UP_MS, JITTER.STEP_DOWN_MS) + 1e-6,
      `target moved ${Math.abs(ctl.targetMs - before)} ms in one update`,
    );
    max = Math.max(max, ctl.targetMs);
    min = Math.min(min, ctl.targetMs);
  }
  assert.ok(max <= 400, 'target never exceeds configured ceiling');
  assert.ok(min >= 40, 'target never below floor');
});

test('individual late packets do not ratchet target upward', () => {
  const ctl = new TargetController();
  const t0 = 0;
  // Settle with no jitter: the needed headroom is 20 ms which clamps to 40.
  ctl.update(0, 0, 1000);
  for (let t = 0; t < 60000; t += 20) ctl.update(t, 0, 1000);
  const settled = ctl.targetMs;
  // Deliver "late packets" as a stream of excess observations, but the
  // controller only sees an *unchanged smoothed jitter*, exactly as it would if
  // the EWMA filtered the spike out. The target must not move.
  for (let t = 60000; t < 120000; t += 20) ctl.update(t, 0, 1000);
  assert.equal(ctl.targetMs, settled);
  assert.ok(ctl.raiseCount === 0 || ctl.targetMs <= JITTER.MAX_MS);
});

test('underrun raises target but is rate limited', () => {
  const ctl = new TargetController();
  assert.ok(ctl.onUnderrun(0));
  const afterFirst = ctl.targetMs;
  assert.equal(ctl.onUnderrun(500), false, 'within window');
  assert.equal(ctl.targetMs, afterFirst);
  assert.ok(ctl.onUnderrun(JITTER.UNDERRUN_WINDOW_MS + 1));
});

test('arrival tracker EWMA reacts to sustained jitter and follows low-water mark', () => {
  const tr = new ArrivalTracker();
  for (let i = 0; i < 200; i++) tr.observe(i * 20000, i * 20 + 70);
  const base = tr.jitterMs;
  assert.ok(base < 0.01, `steady path yields ~0 jitter, got ${base}`);
  // Introduce +/- 40 ms alternating arrival offsets.
  for (let i = 200; i < 400; i++) {
    const extra = i % 2 ? 40 : -40;
    tr.observe(i * 20000, i * 20 + 70 + extra);
  }
  assert.ok(tr.jitterMs > 20, `jitter should rise, got ${tr.jitterMs}`);
});

test('reorder gate emits exact gap spans and never moves next packet into hole', () => {
  const gate = new PacketGate({ ...JITTER, REPAIR_WAIT_MS: 70, MAX_GAP_FRAMES: 25 });
  let events = gate.push(0, 'f0', 0);
  assert.deepEqual(events, [{ type: 'frame', seq: 0, unwrappedSeq: 0, item: 'f0' }]);
  // 1 and 2 are lost; 3 arrives and must wait behind the hole.
  events = gate.push(3, 'f3', 25);
  assert.equal(events.length, 0, 'frame behind a hole is held');
  events = gate.push(4, 'f4', 60);
  assert.equal(events.length, 0);
  // After the repair wait, a gap of exactly 2 frames (seq 1,2) is emitted, then
  // frames 3 and 4 in order. The next arriving packet is 5.
  events = gate.push(5, 'f5', 96);
  assert.equal(events[0].type, 'gap');
  assert.equal(events[0].startSeq, 1);
  assert.equal(events[0].count, 2);
  assert.deepEqual(
    events.slice(1).map((e) => [e.type, e.seq]),
    [
      ['frame', 3],
      ['frame', 4],
      ['frame', 5],
    ],
  );
});

test('reorder gate handles up to bound reordering without gaps', () => {
  const gate = new PacketGate();
  const order = [0, 2, 1, 4, 3, 6, 5, 8, 7];
  let all = [];
  order.forEach((seq, i) => {
    all = all.concat(gate.push(seq, `f${seq}`, i * 10));
  });
  all = all.concat(gate.poll(1000));
  const frames = all.filter((e) => e.type === 'frame').map((e) => e.seq);
  assert.deepEqual(frames, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(all.filter((e) => e.type === 'gap').length, 0);
  assert.ok(gate.stats.reordered >= 4);
});

test('duplicates are counted and ignored', () => {
  const gate = new PacketGate();
  gate.push(0, 'a', 0);
  gate.push(1, 'b', 5);
  gate.push(1, 'b', 6);
  assert.equal(gate.stats.duplicates, 1);
});

test('large jump becomes resync rather than hundreds of concealed frames', () => {
  const gate = new PacketGate({ ...JITTER, REPAIR_WAIT_MS: 10, MAX_GAP_FRAMES: 5 });
  gate.push(0, 'a', 0);
  const ev = gate.push(100, 'b', 20);
  assert.equal(ev[0].type, 'resync');
  assert.equal(ev[0].toSeq, 100);
  assert.equal(ev[1].seq, 100);
  assert.equal(gate.stats.resyncs, 1);
});

test('drift controller clamps ratio and corrects in the right direction', () => {
  const d = new DriftController();
  assert.ok(Math.abs(d.update(200, 100) - (1 - JITTER.DRIFT_MAX_RATIO)) < 1e-9, 'too full -> slow down');
  assert.ok(Math.abs(d.update(0, 100) - (1 + JITTER.DRIFT_MAX_RATIO)) < 1e-9, 'too empty -> speed up');
  assert.equal(d.update(100, 100), 1);
});

test('resampleFrame keeps timeline length proportional and stays finite', () => {
  const input = new Float32Array(960);
  for (let i = 0; i < 960; i++) input[i] = Math.sin((i / 48000) * 2 * Math.PI * 440);
  const slow = resampleFrame(input, 0.995);
  const fast = resampleFrame(input, 1.005);
  assert.equal(slow.length, 955);
  assert.equal(fast.length, 965);
  for (const arr of [slow, fast]) for (const v of arr) assert.ok(Number.isFinite(v));
});

test('concealment span is exactly the missing duration and fades to silence', () => {
  const last = new Float32Array(960).fill(0.5);
  const span = concealmentSpan(last, 3);
  assert.equal(span.length, 2880);
  assert.ok(Math.abs(span[959]) < 1e-6, 'fade completes inside first frame');
  assert.equal(span[960], 0);
  assert.equal(span[2879], 0);
});

test('network impairment is deterministic per seed and reports stats', () => {
  const profile = { baseMs: 50, jitterMs: 20, lossPct: 5, reorderPct: 10, dupPct: 5, seed: 42 };
  const a = new NetworkImpairment(profile);
  const b = new NetworkImpairment(profile);
  const sa = [];
  const sb = [];
  for (let i = 0; i < 500; i++) {
    sa.push(JSON.stringify(a.plan(i * 20)));
    sb.push(JSON.stringify(b.plan(i * 20)));
  }
  assert.deepEqual(sa, sb);
  assert.ok(a.stats().dropped > 0 && a.stats().dropped < 50);
  assert.ok(a.stats().duplicated > 0);
  assert.ok(a.stats().reordered > 0);
});

test('delay step profile changes delay at the configured time', () => {
  const n = new NetworkImpairment({ baseMs: 40, jitterMs: 0, step: { atMs: 1000, extraMs: 120 }, seed: 1 });
  const early = n.plan(0).deliver[0].atMs - 0;
  const late = n.plan(1200).deliver[0].atMs - 1200;
  assert.equal(early, 40);
  assert.equal(late, 160);
});

test('delivery queue pops in timestamp order', () => {
  const q = new DeliveryQueue();
  const r = mulberry32(9);
  const times = [];
  for (let i = 0; i < 300; i++) {
    const at = Math.floor(r() * 5000);
    times.push(at);
    q.push(at, i);
  }
  const got = [];
  let now = 0;
  while (q.size) {
    now += 1;
    for (const it of q.popDue(now)) got.push(it.atMs);
  }
  assert.equal(got.length, 300);
  for (let i = 1; i < got.length; i++) assert.ok(got[i] >= got[i - 1]);
});

// ---------------------------------------------------------------------------
// Timeline placement: this is the rule that guarantees a hole is concealed for
// exactly its own span and the next packet keeps its position.
// ---------------------------------------------------------------------------
test('placement: first frame establishes the epoch', () => {
  assert.deepEqual(classifyPlacement(null, 12345, 960, 25), { mode: 'epoch', deltaFrames: 0 });
});

// The cursor points at the start of the next expected frame (the kernel
// advances it by the frame length after writing), so contiguity is
// cursor === frameMediaSample.
test('placement: contiguous frame is placed, never concealed', () => {
  assert.deepEqual(classifyPlacement(101 * 960, 101 * 960, 960, 25), { mode: 'place', deltaFrames: 0 });
});

test('placement: missing frames become an exact conceal span then the real frame', () => {
  const r = classifyPlacement(101 * 960, 104 * 960, 960, 25);
  assert.deepEqual(r, { mode: 'conceal', deltaFrames: 3 });
});

test('placement: duplicate or overlapping media is dropped, never rewinds', () => {
  assert.deepEqual(classifyPlacement(101 * 960, 100 * 960, 960, 25), { mode: 'drop', deltaFrames: -1 });
  assert.deepEqual(classifyPlacement(101 * 960, 101 * 960 - 480, 960, 25), { mode: 'drop', deltaFrames: 0 });
});

test('placement: a large jump is a media-period rebase, not 300 frames of concealment', () => {
  assert.deepEqual(classifyPlacement(10 * 960, 400 * 960, 960, 25), { mode: 'rebase', deltaFrames: 390 });
});

test('concealment length matches the media hole exactly', () => {
  const hole = classifyPlacement(1001 * 960, 1005 * 960, 960, 25);
  const span = concealmentSpan(new Float32Array(960).fill(0.3), hole.deltaFrames);
  assert.equal(span.length, 4 * 960);
  // The packet that follows the hole starts one sample after this span in the
  // ring, i.e. the hole occupies exactly its own four frames of time.
});

// ---------------------------------------------------------------------------
// Drift: run a long, skewed clock and verify the correction keeps occupancy
// bounded and that no whole-chunk drops are needed.
// ---------------------------------------------------------------------------
test('drift controller keeps a 0.5 % fast sound card converged without chunk drops', () => {
  const SR = 48000;
  const targetMs = 120;
  const drift = new DriftController();
  // Device consumes 0.5 % faster than media arrives (worst realistic case).
  const deviceRate = 1.005;
  let occupancySamples = 120 * 48; // start at target
  let minOcc = occupancySamples;
  let maxOcc = occupancySamples;
  let ratioSum = 0;
  let n = 0;
  for (let tick = 0; tick < 60 * 100; tick++) {
    // Every 10 ms the device consumes 480*deviceRate samples.
    occupancySamples -= 480 * deviceRate;
    // Media arrives at 480 samples per 10 ms, resampled by the controller.
    const occMs = occupancySamples / 48;
    const ratio = drift.update(occMs, targetMs);
    occupancySamples += 480 * ratio;
    ratioSum += ratio;
    n++;
    minOcc = Math.min(minOcc, occupancySamples);
    maxOcc = Math.max(maxOcc, occupancySamples);
    if (occupancySamples <= 0) {
      assert.fail(`underrun at tick ${tick}`);
    }
  }
  const avgRatio = ratioSum / n;
  const minMs = minOcc / 48;
  const maxMs = maxOcc / 48;
  // A fast device drains the ring faster than media arrives, so the controller
  // must stretch each media frame slightly (ratio > 1) to keep occupancy level.
  assert.ok(avgRatio > 1, `controller must add samples on a fast device, avg ratio ${avgRatio}`);
  assert.ok(minMs > 40, `occupancy never starves, min ${minMs.toFixed(1)} ms`);
  assert.ok(maxMs < 400, `occupancy stays bounded, max ${maxMs.toFixed(1)} ms`);
  // Correcting 0.5 % requires only ~0.5 % time scaling, far from the 1 % clamp.
  assert.ok(Math.abs(avgRatio - 1.005) < 0.004, `ratio stays close to real drift, got ${avgRatio}`);
});

test('target never exceeds MAX_MS even when jitter estimate is absurd', () => {
  const ctl = new TargetController();
  let t = 0;
  // Drive it long enough to reach the ceiling via rate-limited steps.
  for (let i = 0; i < 100000; i++) {
    t += 20;
    ctl.update(t, 5000, 50);
    assert.ok(ctl.targetMs <= JITTER.MAX_MS);
  }
  assert.equal(ctl.targetMs, JITTER.MAX_MS);
});

// ---------------------------------------------------------------------------
// Boundary reproductions: u32 sequence wraparound and packets crossing the
// repair deadline exactly. These started as minimal reproducers for stalls
// and misclassified packets at the wrap; they now pin the modular sequence
// arithmetic and the output-advance relation.
// ---------------------------------------------------------------------------
test('sequence math: forward distance is modular over the u32 wire space', () => {
  assert.equal(seqForwardDistance(0xfffffffe, 0), 2);
  assert.equal(seqForwardDistance(0xffffffff, 0xffffffff), 0);
  assert.equal(seqForwardDistance(0, 0xffffffff), 0xffffffff);
  assert.equal(seqForwardDistance(100, 0), 0xffffff9c);
  assert.equal(seqForwardDistance(5, 5 + 25), 25);
});

test('sequence wraparound: gate keeps delivering across the u32 boundary', () => {
  const gate = new PacketGate();
  const seqs = [0xfffffffc, 0xfffffffd, 0xfffffffe, 0xffffffff, 0, 1, 2];
  const delivered = [];
  seqs.forEach((seq, i) => {
    for (const ev of gate.push(seq, `f${seq}`, i * 20)) {
      if (ev.type === 'frame') delivered.push(ev.seq);
    }
  });
  // Every packet is eligible after the wrap; none is "late".
  assert.deepEqual(delivered, seqs);
  assert.equal(gate.stats.late, 0);
  assert.equal(gate.stats.gaps, 0);
});

test('sequence wraparound with a hole at the boundary emits a sane gap and recovers', () => {
  const gate = new PacketGate({ ...JITTER, REPAIR_WAIT_MS: 70, MAX_GAP_FRAMES: 25 });
  gate.push(0xfffffffd, 'a', 0); // delivered, cursor at 0xfffffffe
  gate.push(0xffffffff, 'c', 10); // one hole (0xfffffffe), held
  const held = gate.push(0, 'd', 20); // two ahead across the wrap: held, not "late"
  assert.equal(held.length, 0);
  assert.equal(gate.stats.late, 0, 'post-wrap packet must not be condemned as late');
  const events = gate.poll(100); // repair wait for the hole expires
  const gap = events.find((e) => e.type === 'gap');
  assert.ok(gap, 'a gap event is expected');
  assert.equal(gap.startSeq, 0xfffffffe);
  assert.equal(gap.count, 1, 'the hole is exactly one frame, not a negative or huge span');
  const frames = events.filter((e) => e.type === 'frame').map((e) => e.seq);
  assert.deepEqual(frames, [0xffffffff, 0], 'queued frames drain in wire order across the wrap');
  assert.equal(gate.stats.gapFrames, 1);
  const more = gate.push(1, 'e', 120);
  assert.deepEqual(
    more.filter((e) => e.type === 'frame').map((e) => e.seq),
    [1],
    'stream continues after the wrap',
  );
});

test('frame events carry a monotonic unwrapped sequence across wrap and resync', () => {
  const gate = new PacketGate({ ...JITTER, REPAIR_WAIT_MS: 10, MAX_GAP_FRAMES: 5 });
  const seen = [];
  const resyncs = [];
  const feed = (seq, t) => {
    for (const ev of gate.push(seq, null, t)) {
      if (ev.type === 'frame') seen.push([ev.seq, ev.unwrappedSeq]);
      if (ev.type === 'resync') resyncs.push(ev);
    }
  };
  feed(0xfffffffe, 0);
  feed(0xffffffff, 10);
  feed(0, 20);
  feed(1, 30);
  assert.deepEqual(
    seen.map(([, u]) => u),
    [0xfffffffe, 0xffffffff, 0x100000000, 0x100000001],
    'media positions must not wrap: the playout timeline stays monotonic',
  );
  // A forward discontinuity resyncs and the unwrapped position jumps with it,
  // so the playout side still sees the gap as a media-period change.
  feed(0x1000, 40);
  feed(0x1001, 50);
  assert.equal(resyncs.length, 1);
  assert.equal(resyncs[0].fromSeq, 2);
  assert.equal(resyncs[0].toSeq, 0x1000);
  const jump = seen[seen.length - 2][1] - seen[seen.length - 3][1];
  assert.equal(jump, 0x1000 - 1, 'resync advances the timeline by the skipped span');
  assert.equal(seen[seen.length - 1][1] - seen[seen.length - 2][1], 1);
});

test('deadline boundary: a packet pushed exactly at the repair deadline still fills the hole', () => {
  const gate = new PacketGate({ ...JITTER, REPAIR_WAIT_MS: 70, MAX_GAP_FRAMES: 25 });
  gate.push(0, 'f0', 0);
  gate.push(2, 'f2', 10); // hole at 1, wait starts at 10
  // Arrives exactly at waitStart + REPAIR_WAIT_MS. Pushed packets always get
  // their chance: the deadline only governs giving up, never refuses arrivals.
  const events = gate.push(1, 'f1', 80);
  assert.deepEqual(
    events.map((e) => [e.type, e.seq]),
    [
      ['frame', 1],
      ['frame', 2],
    ],
  );
  assert.equal(gate.stats.gaps, 0);
  assert.equal(gate.stats.late, 0);
});

test('deadline boundary: poll at exactly the deadline gives up; the late copy is dropped once', () => {
  const gate = new PacketGate({ ...JITTER, REPAIR_WAIT_MS: 70, MAX_GAP_FRAMES: 25 });
  gate.push(0, 'f0', 0);
  gate.push(2, 'f2', 10); // hole at 1
  const events = gate.poll(80); // waited exactly REPAIR_WAIT_MS
  assert.deepEqual(
    events.map((e) => e.type),
    ['gap', 'frame'],
  );
  assert.equal(events[0].startSeq, 1);
  assert.equal(events[0].count, 1);
  // The first copy arrives after its span was concealed: dropped as late,
  // counted exactly once, and never re-emitted (no duplicate samples later).
  const late = gate.push(1, 'f1-late', 90);
  assert.equal(late.length, 0);
  assert.equal(gate.stats.late, 1);
  assert.equal(gate.stats.duplicates, 0);
  // A re-send of an already-played packet is a duplicate, not "late".
  gate.push(0, 'f0-dup', 95);
  assert.equal(gate.stats.duplicates, 1);
  assert.equal(gate.stats.late, 1);
});

// Minimal model of the kernel's receive path: gate events feed timeline
// placement; the output is the exact sequence of sample spans appended to the
// playout ring. This is the harness that maps output sample order and gaps to
// executable evidence.
function makeOutputModel() {
  const timeline = new PlayoutTimeline(JITTER.MAX_GAP_FRAMES);
  const spans = [];
  return {
    spans,
    accept(ev) {
      assert.equal(
        typeof ev.unwrappedSeq,
        'number',
        'frame events must carry an unwrapped media sequence',
      );
      const pcm = new Float32Array(FRAME_SAMPLES).fill(0.01 * (ev.seq % 97));
      const r = timeline.accept(ev.unwrappedSeq * FRAME_SAMPLES, pcm);
      if (r.mode === 'conceal') {
        spans.push({ kind: 'conceal', frames: r.concealFrames, at: r.at - r.concealFrames * FRAME_SAMPLES });
      }
      if (r.mode === 'epoch' || r.mode === 'place' || r.mode === 'conceal') {
        spans.push({ kind: 'frame', seq: ev.seq, at: r.at });
      }
      return r;
    },
  };
}

test('output sample order: wrap, loss and late arrivals never duplicate or shift samples', () => {
  const gate = new PacketGate({ ...JITTER, REPAIR_WAIT_MS: 70, MAX_GAP_FRAMES: 25 });
  const out = makeOutputModel();
  const pump = (seq, t) => {
    for (const ev of gate.push(seq, seq, t)) if (ev.type === 'frame') out.accept(ev);
  };
  const poll = (t) => {
    for (const ev of gate.poll(t)) if (ev.type === 'frame') out.accept(ev);
  };

  pump(0xfffffffc, 0);
  pump(0xfffffffd, 20);
  pump(0xfffffffe, 40);
  pump(0, 60); // belongs after 0xffffffff, which is lost; held behind the hole
  pump(1, 80);
  poll(140); // repair deadline for the hole at 0xffffffff
  pump(2, 160);
  pump(0xffffffff, 180); // the lost packet, far too late: gate must drop it
  pump(3, 200);

  const kinds = out.spans.map((s) => s.kind);
  assert.deepEqual(kinds, [
    'frame', // 0xfffffffc (epoch)
    'frame', // 0xfffffffd
    'frame', // 0xfffffffe
    'conceal', // exactly one frame for the lost 0xffffffff
    'frame', // 0
    'frame', // 1
    'frame', // 2
    'frame', // 3
  ]);
  const conceal = out.spans.find((s) => s.kind === 'conceal');
  assert.equal(conceal.frames, 1, 'the hole is concealed for exactly its own span');

  // Output positions are strictly contiguous: each span starts where the
  // previous one ended. No overlap (duplicate samples) and no unaccounted
  // hole (silence that was never concealed).
  let expect = 0xfffffffc * FRAME_SAMPLES;
  for (const s of out.spans) {
    assert.equal(s.at, expect, `span ${s.kind} seq=${s.seq ?? ''} misplaced`);
    expect += (s.kind === 'conceal' ? s.frames : 1) * FRAME_SAMPLES;
  }
  assert.equal(gate.stats.late, 1, 'only the resurrected packet is late');
  assert.equal(gate.stats.duplicates, 0);
});

test('concealment fades from the frame that actually preceded the hole', () => {
  const timeline = new PlayoutTimeline(JITTER.MAX_GAP_FRAMES);
  const before = new Float32Array(FRAME_SAMPLES).fill(0.5);
  const after = new Float32Array(FRAME_SAMPLES).fill(-0.9);
  timeline.accept(1000 * FRAME_SAMPLES, before); // played just before the hole
  const r = timeline.accept(1003 * FRAME_SAMPLES, after); // 2-frame hole
  assert.equal(r.mode, 'conceal');
  assert.equal(r.concealFrames, 2);
  // The fade must start from the last sample of the pre-hole frame (0.5),
  // never from the post-hole frame (-0.9): compensation comes from the audio
  // that was actually played, not from the future.
  assert.ok(Math.abs(r.concealPcm[0] - 0.5 * (1 - 1 / FRAME_SAMPLES)) < 1e-7);
  assert.ok(Math.abs(r.concealPcm[0] - -0.9 * (1 - 1 / FRAME_SAMPLES)) > 0.1);
});

test('placement timeline: dropped frames never become the concealment source', () => {
  const timeline = new PlayoutTimeline(JITTER.MAX_GAP_FRAMES);
  const good = new Float32Array(FRAME_SAMPLES).fill(0.25);
  timeline.accept(0, good);
  // A duplicate/overlapping frame arrives and is dropped: it was never played,
  // so it must not become the reference for later concealment.
  const dup = new Float32Array(FRAME_SAMPLES).fill(0.99);
  const d = timeline.accept(0, dup);
  assert.equal(d.mode, 'drop');
  const r = timeline.accept(2 * FRAME_SAMPLES, new Float32Array(FRAME_SAMPLES).fill(0.1));
  assert.equal(r.mode, 'conceal');
  assert.ok(Math.abs(r.concealPcm[0] - 0.25 * (1 - 1 / FRAME_SAMPLES)) < 1e-7);
});
