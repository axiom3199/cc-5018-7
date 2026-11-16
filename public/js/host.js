import { RemoteAudioClient } from './client.js';
import { HostAudioIO } from './audio-io.js';
import {
  JITTER,
  NETWORK_PROFILES,
  SAB,
  SAB_BYTES,
  MON_SAMPLES,
  MON_MASK,
  MON_BYTE_OFFSET,
  RING_SAMPLES,
  RING_BYTE_OFFSET,
  samplesToMs,
  clamp,
} from './protocol.js';

const $ = (id) => document.getElementById(id);

const ui = {
  connect: $('btn-connect'),
  disconnect: $('btn-disconnect'),
  marker: $('btn-marker'),
  resync: $('btn-resync'),
  monitor: $('btn-monitor'),
  forceUnderrun: $('btn-force-underrun'),
  sim: $('btn-sim'),
  pulseTest: $('btn-pulse-test'),
  report: $('btn-report'),
  dotWs: $('dot-ws'),
  txtWs: $('txt-ws'),
  dotPeer: $('dot-peer'),
  txtPeer: $('txt-peer'),
  dotCrypto: $('dot-crypto'),
  txtCrypto: $('txt-crypto'),
  banner: $('banner'),
  tagPeriod: $('tag-period'),
  tagNegotiation: $('tag-negotiation'),
  queueFill: $('queue-fill'),
  queueTarget: $('queue-target'),
  queueDepth: $('queue-depth'),
  queueTargetMs: $('queue-target-ms'),
  log: $('event-log'),
  simSummary: $('sim-summary'),
  feedbackStatus: $('feedback-status'),
  resultSummary: $('result-summary'),
};

let client = null;
let audioIO = null;
let ringSab = null;
let ctrl = null;
let ring = null;
let mon = null;

let history = [];
let scopeBuf = new Float32Array(2048);
let playing = false;
let monitorOn = true;
let markerAvg = 0;
let markerMax = 0;
let markerCount = 0;
let lastPlayedSample = 0;
let lastPlayedAt = 0;
let playoutSampleRate = 0;

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function boot() {
  const isolated = self.crossOriginIsolated;
  ui.dotCrypto.className = `dot ${isolated ? 'ok' : 'bad'}`;
  ui.txtCrypto.textContent = isolated ? '跨源隔离已启用' : '缺少跨源隔离（SAB 不可用）';
  $('ck-isolation').textContent = isolated ? '✓' : '✕';
  $('ck-isolation').className = `mark ${isolated ? 'ok' : 'bad'}`;
  const codecs = typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
  $('ck-codecs').textContent = codecs ? '✓' : '✕';
  $('ck-codecs').className = `mark ${codecs ? 'ok' : 'bad'}`;
  const worklet = typeof AudioWorkletNode !== 'undefined';
  $('ck-worklet').textContent = worklet ? '✓' : '✕';
  $('ck-worklet').className = `mark ${worklet ? 'ok' : 'bad'}`;

  if (!isolated || !codecs) {
    banner('此浏览器缺少跨源隔离或 WebCodecs Opus，实时链路不可用。请用 Chrome/Edge 通过 http://localhost 打开。', 'error');
  }

  drawScope();
  drawTimeline();
  requestAnimationFrame(tick);
}

function banner(text, kind = '') {
  ui.banner.textContent = text;
  ui.banner.className = `banner ${kind}`;
  ui.banner.classList.remove('hidden');
}

function log(text, kind = '') {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">${t}</span> <span class="${kind}">${escapeHtml(text)}</span>`;
  ui.log.prepend(line);
  while (ui.log.childElementCount > 120) ui.log.lastChild.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// connect / disconnect
// ---------------------------------------------------------------------------
async function connect() {
  ui.connect.disabled = true;
  try {
    ringSab = new SharedArrayBuffer(SAB_BYTES);
    ctrl = new Int32Array(ringSab, 0, SAB.INT_SLOTS);
    ring = new Float32Array(ringSab, RING_BYTE_OFFSET, RING_SAMPLES);
    mon = new Float32Array(ringSab, MON_BYTE_OFFSET, MON_SAMPLES);
    // Read-only debugging/test probes. Playback decisions stay in the kernel.
    window.__hostCtl = ctrl;
    window.__hostRing = ring;
    window.__hostMon = mon;
    window.__hostProbe = () => ({
      read: Atomics.load(ctrl, SAB.READ_SAMPLE) >>> 0,
      write: Atomics.load(ctrl, SAB.WRITE_SAMPLE) >>> 0,
      playing: Atomics.load(ctrl, SAB.PLAYING) === 1,
      monWrite: Atomics.load(ctrl, SAB.MON_WRITE),
      underruns: Atomics.load(ctrl, SAB.UNDERRUNS),
    });

    client = new RemoteAudioClient({ onEvent });
    await client.init('host', {
      session: $('session-name').value.trim() || 'studio',
      name: 'host',
      ringSab,
      deviceSkewPpm: Number($('skew-range').value),
    });

    // The page owns the sound card and starts the playout worklet; the kernel
    // owns the ring contents and all buffer decisions.
    audioIO = new HostAudioIO({
      ringSab,
      onUnderrun: () => client?.audioUnderrun({}),
      onReady: (info) => client?.audioReady(info),
    });
    const ioInfo = await audioIO.start();
    client.audioReady(ioInfo);
    audioIO.setMonitor(monitorOn);
    client.control('set-monitor', { on: monitorOn });

    log('接收端内核已启动，等待嘉宾…');
    banner('已建立接收端。请在另一个标签页打开远程嘉宾页并连接同名会话。', 'ok');
    ui.disconnect.disabled = false;
    ui.resync.disabled = false;
    ui.marker.disabled = false;
    ui.monitor.disabled = false;
    ui.forceUnderrun.disabled = false;
    updateMonitorButton();
  } catch (err) {
    ui.connect.disabled = false;
    banner(`启动接收端失败：${err.message}`, 'error');
    log(`启动失败：${err.message}`, 'bad');
  }
}

function disconnect() {
  client?.destroy();
  audioIO?.stop();
  client = null;
  audioIO = null;
  playing = false;
  ui.connect.disabled = false;
  ui.disconnect.disabled = true;
  ui.resync.disabled = true;
  ui.marker.disabled = true;
  ui.monitor.disabled = true;
  ui.forceUnderrun.disabled = true;
  setWsUi(false, '未连接');
  setPeerUi(false, '等待嘉宾');
  banner('已断开接收端。', '');
  log('已断开');
}

// ---------------------------------------------------------------------------
// kernel events
// ---------------------------------------------------------------------------
function onEvent(type, payload) {
  switch (type) {
    case 'ws-open':
      log('WebSocket 已打开，注册为 host', 'ok');
      setWsUi(true, '已连接');
      $('ck-ws').textContent = '✓';
      $('ck-ws').className = 'mark ok';
      break;
    case 'ws-close':
      setWsUi(false, '连接断开');
      log('WebSocket 断开；内核将保持就绪，可重连', 'warn');
      $('ck-ws').textContent = '✕';
      $('ck-ws').className = 'mark bad';
      break;
    case 'welcome': {
      $('tag-period').textContent = `媒体期 ${payload.period}`;
      log(`服务端确认：会话 ${payload.session}，媒体期 ${payload.period}`);
      banner(payload.peerPresent ? '嘉宾已在线，等待其开始发送。' : '已连接中继，等待嘉宾进入。', payload.peerPresent ? 'ok' : '');
      break;
    }
    case 'peer-state': {
      ui.tagPeriod.textContent = `媒体期 ${payload.period}`;
      const guest = payload.guestConnected;
      setPeerUi(guest, guest ? `嘉宾在线 · ${payload.guest?.name || 'guest'}` : '等待嘉宾');
      if (guest) {
        log(`嘉宾已上线（媒体期 ${payload.period}）`, 'ok');
        banner('嘉宾在线。收到媒体后缓冲填满即自动开始播放。', 'ok');
      } else {
        log('嘉宾离线：媒体期结束，接收端等待重新建立', 'warn');
        banner('嘉宾已断线。接收端保留会话；嘉宾重新进入后会自动开始新的媒体期。', '');
      }
      break;
    }
    case 'ring-ready':
      ringSab = payload.ringSab;
      ctrl = new Int32Array(ringSab, 0, SAB.INT_SLOTS);
      ring = new Float32Array(ringSab, RING_BYTE_OFFSET, RING_SAMPLES);
      mon = new Float32Array(ringSab, MON_BYTE_OFFSET, MON_SAMPLES);
      log('播放环已就绪（AudioWorklet 已连接）');
      break;
    case 'negotiation':
      $('tag-negotiation').textContent = fmtNegotiation(payload);
      if (payload.workletRate) playoutSampleRate = payload.workletRate;
      break;
    case 'state':
      if (payload.stats?.negotiation) $('tag-negotiation').textContent = fmtNegotiation(payload.stats.negotiation);
      break;
    case 'playing':
      playing = true;
      banner('正在播放远程嘉宾音频。', 'ok');
      log(`开始播放：队列 ${payload.occupancyMs?.toFixed?.(0) ?? '—'} ms，目标 ${payload.targetMs} ms`, 'ok');
      $('ck-play').textContent = '✓';
      $('ck-play').className = 'mark ok';
      break;
    case 'underrun':
      playing = false;
      log(`播放欠载 #${payload.count}：缓冲区耗尽，目标提高到 ${payload.targetMs} ms`, 'bad');
      banner('播放欠载：已停止播放并提高目标水位，等待缓冲重新填满。', 'error');
      client?.feedback({ kind: 'result', event: 'underrun', count: payload.count, targetMs: payload.targetMs });
      break;
    case 'conceal':
      client?.feedback({ kind: 'result', event: 'conceal', frames: payload.frames, reason: payload.reason });
      break;
    case 'rebase':
      log(`媒体期重建（${payload.reason}），队列已清空，等待新周期填满`, 'warn');
      break;
    case 'resync':
      log(`序号跳变：${payload.fromSeq} → ${payload.toSeq}，判定为媒体期重建`, 'warn');
      break;
    case 'target':
      log(`目标水位 ${payload.targetMs} ms（${payload.reason}${payload.biasMs ? `，偏置 ${payload.biasMs} ms` : ''}）`);
      break;
    case 'marker':
      markerCount++;
      markerAvg = markerAvg ? markerAvg * 0.8 + payload.bufferLatencyMs * 0.2 : payload.bufferLatencyMs;
      markerMax = Math.max(markerMax, payload.bufferLatencyMs);
      $('m-markers').textContent = markerCount;
      $('m-avg-latency').innerHTML = `${markerAvg.toFixed(1)}<small> ms</small>`;
      $('m-max-latency').innerHTML = `${markerMax.toFixed(1)}<small> ms</small>`;
      $('m-latency').innerHTML = `${payload.bufferLatencyMs.toFixed(1)}<small> ms</small>`;
      ui.resultSummary.textContent = `已测得 ${markerCount} 个标记：当前缓冲时延 ${payload.bufferLatencyMs.toFixed(1)} ms，平均 ${markerAvg.toFixed(1)} ms，最大 ${markerMax.toFixed(1)} ms（接收→播放，不含网络单程）。`;
      log(`时延标记：缓冲 ${payload.bufferLatencyMs.toFixed(1)} ms（平均 ${markerAvg.toFixed(1)} ms）`, 'ok');
      break;
    case 'marker-received':
      log(`收到嘉宾标记 seq=${payload.seq}`);
      break;
    case 'marker-echo':
      log(`标记回传：RTT ${payload.rttMs?.toFixed(1)} ms，估算端到端 ${payload.e2eMs?.toFixed(1)} ms`);
      break;
    case 'feedback':
      log(`收到反馈：${JSON.stringify(payload).slice(0, 160)}`);
      break;
    case 'peer-stats':
      $('s-drift').textContent = Number(payload.driftRatio ?? 1).toFixed(5);
      break;
    case 'period-end':
      playing = false;
      $('ck-play').textContent = '·';
      $('ck-play').className = 'mark';
      log(`媒体期结束：${payload.reason}`, 'warn');
      break;
    case 'speech-loaded':
      log(`嘉宾端语音素材已加载：${payload.seconds.toFixed(1)} s @ ${payload.sampleRate} Hz`);
      break;
    case 'simulation':
      renderSimulation(payload.result);
      break;
    case 'error':
      log(`内核错误：${payload.message}`, 'bad');
      banner(`远程音频错误：${payload.message}`, 'error');
      ui.feedbackStatus.textContent = `失败：${payload.message}`;
      break;
    case 'stats':
      if (payload.stats) applyStats(payload.stats);
      break;
    default:
      break;
  }
  if (type === 'peer-state' || type === 'welcome') updateChecklist();
}

function fmtNegotiation(n) {
  if (!n) return '—';
  const bits = [];
  if (n.opusDecoder) bits.push('Opus 解码');
  if (n.workletRate) bits.push(`Worklet ${n.workletRate} Hz`);
  else if (n.contextRate) bits.push(`AudioContext ${n.contextRate} Hz`);
  return bits.join(' · ') || '—';
}

function applyStats(s) {
  $('m-played').textContent = Number(s.samplesPlayed || 0).toLocaleString('en-US');
  $('m-queue').innerHTML = `${(s.occupancyMs ?? 0).toFixed(0)}<small> ms</small>`;
  $('m-target').innerHTML = `${(s.targetMs ?? 0).toFixed(0)}<small> ms</small>`;
  const jitterEl = $('m-jitter');
  jitterEl.innerHTML = `${(s.jitterMs ?? 0).toFixed(1)}<small> ms</small>`;
  jitterEl.parentElement.className = `metric ${(s.jitterMs ?? 0) > 40 ? 'bad' : (s.jitterMs ?? 0) > 15 ? 'warn' : 'good'}`;
  $('m-underruns').textContent = `${s.underruns ?? 0} / ${s.gaps ?? 0}`;
  $('s-packets').textContent = Number(s.packetsReceived || 0).toLocaleString('en-US');
  $('s-frames').textContent = Number(s.framesDecoded || 0).toLocaleString('en-US');
  $('s-reorder').textContent = `${s.reordered ?? 0} / ${s.duplicates ?? 0}`;
  $('s-late').textContent = s.late ?? 0;
  $('s-gaps').textContent = s.gaps ?? 0;
  $('s-conceal').textContent = Number(s.concealedSamples || 0).toLocaleString('en-US');
  $('s-resync').textContent = s.resyncs ?? 0;
  $('s-drift').textContent = Number(s.driftRatio ?? 1).toFixed(5);
  $('s-enc-err').textContent = s.encodeErrors ?? 0;
  $('s-dec-err').textContent = s.decodeErrors ?? 0;
  $('s-bytes').textContent = fmtBytes(s.bytesReceived);
  $('s-sent').textContent = fmtBytes(s.bytesSent);

  history.push({ at: performance.now(), queue: s.occupancyMs ?? 0, target: s.targetMs ?? 0, jitter: s.jitterMs ?? 0 });
  if (history.length > 240) history.shift();

  if (s.eventLog) renderEventLog(s.eventLog);
  updateChecklist(s);
}

let lastEventLogKey = '';
function renderEventLog(events) {
  const key = events.map((e) => `${e.at}:${e.kind}`).join('|');
  if (key === lastEventLogKey) return;
  lastEventLogKey = key;
  for (const e of events.slice(-6)) {
    log(`[内核] ${e.kind} ${e.detail ? JSON.stringify(e.detail) : ''}`);
  }
}

function updateChecklist(s) {
  const focus = s || client?.stats || {};
  if (focus.opusDecoder !== undefined) {
    $('ck-codecs').textContent = focus.opusDecoder ? '✓' : '✕';
    $('ck-codecs').className = `mark ${focus.opusDecoder ? 'ok' : 'bad'}`;
  }
  const playingNow = playing;
  $('ck-play').textContent = playingNow ? '✓' : '·';
  $('ck-play').className = `mark ${playingNow ? 'ok' : ''}`;
}

function fmtBytes(b) {
  const n = Number(b || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function setWsUi(ok, text) {
  ui.dotWs.className = `dot ${ok ? 'ok' : 'bad'}`;
  ui.txtWs.textContent = text;
}
function setPeerUi(ok, text) {
  ui.dotPeer.className = `dot ${ok ? 'ok' : 'warn'}`;
  ui.txtPeer.textContent = text;
}

// ---------------------------------------------------------------------------
// render loop: queue bar, scope from the monitor ring, timeline
// ---------------------------------------------------------------------------
function tick() {
  requestAnimationFrame(tick);
  if (!ctrl) return;

  const write = Atomics.load(ctrl, SAB.WRITE_SAMPLE) >>> 0;
  const read = Atomics.load(ctrl, SAB.READ_SAMPLE) >>> 0;
  const targetSamples = Atomics.load(ctrl, SAB.TARGET_SAMPLES);
  const occupancy = Math.max(0, write - read);
  const occupancyMs = samplesToMs(occupancy);
  const targetMs = samplesToMs(targetSamples) || JITTER.INITIAL_MS;
  const playingNow = Atomics.load(ctrl, SAB.PLAYING) === 1;
  if (playingNow !== playing && playingNow) {
    playing = true;
    $('ck-play').textContent = '✓';
    $('ck-play').className = 'mark ok';
  }

  const scaleMax = Math.max(480, targetMs * 2.2);
  ui.queueFill.style.width = `${clamp((occupancyMs / scaleMax) * 100, 0, 100)}%`;
  ui.queueTarget.style.left = `${clamp((targetMs / scaleMax) * 100, 0, 100)}%`;
  ui.queueDepth.textContent = occupancyMs.toFixed(0);
  ui.queueTargetMs.textContent = targetMs.toFixed(0);
  $('m-queue').innerHTML = `${occupancyMs.toFixed(0)}<small> ms</small>`;
  $('m-target').innerHTML = `${targetMs.toFixed(0)}<small> ms</small>`;
  $('m-played').textContent = Number(read).toLocaleString('en-US');

  // Playout rate estimate (samples/s) from the worklet read pointer.
  const now = performance.now();
  if (lastPlayedAt && playingNow) {
    const dt = (now - lastPlayedAt) / 1000;
    const ds = read - lastPlayedSample;
    if (dt > 0.05 && ds >= 0) playoutSampleRate = ds / dt;
  }
  lastPlayedAt = now;
  lastPlayedSample = read;

  drawScope();
  drawTimeline();
  drawRms();
}

function drawScope() {
  const canvas = $('scope');
  const ctx = ctx2d(canvas);
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  grid(ctx, w, h);

  if (mon) {
    const monWrite = Atomics.load(ctrl, SAB.MON_WRITE);
    const count = Math.min(2048, monWrite);
    for (let i = 0; i < count; i++) {
      const idx = (monWrite - count + i) & MON_MASK;
      scopeBuf[i] = mon[idx];
    }
    ctx.beginPath();
    ctx.strokeStyle = '#4cc2ff';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < count; i++) {
      const x = (i / (count - 1 || 1)) * w;
      const y = h / 2 - scopeBuf[i] * (h / 2 - 6);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#5f7386';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(`${playoutSampleRate ? Math.round(playoutSampleRate) : 48000} Hz`, w - 78, h - 7);
}

function drawTimeline() {
  const canvas = $('timeline');
  const ctx = ctx2d(canvas);
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  grid(ctx, w, h);
  if (history.length < 2) {
    ctx.fillStyle = '#5f7386';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('等待缓冲数据…', 12, 22);
    return;
  }
  const maxY = Math.max(240, ...history.map((p) => Math.max(p.queue, p.target, p.jitter)));
  const n = history.length;
  const plot = (key, color, width) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    history.forEach((p, i) => {
      const x = (i / (n - 1)) * (w - 8) + 4;
      const y = h - 6 - (p[key] / maxY) * (h - 18);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  plot('jitter', '#5c6f81', 1);
  plot('target', '#ffb020', 1.4);
  plot('queue', '#4cc2ff', 1.6);
  ctx.fillStyle = '#5f7386';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(`${maxY.toFixed(0)} ms`, 6, 12);
}

function drawRms() {
  if (!ctrl) return;
  const rms = Atomics.load(ctrl, SAB.RMS) / 10000;
  const peak = Atomics.load(ctrl, SAB.PEAK) / 10000;
  const el = $('m-jitter');
  // Colour the jitter metric, and flash a thin level bar in its label.
  if (rms > 0) el.title = `输出 RMS ${(20 * Math.log10(rms + 1e-9)).toFixed(1)} dBFS，峰值 ${(20 * Math.log10(peak + 1e-9)).toFixed(1)} dBFS`;
}

function ctx2d(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const cw = Math.max(1, Math.round(rect.width * dpr));
  const ch = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  return canvas.getContext('2d');
}

function grid(ctx, w, h) {
  ctx.save();
  ctx.strokeStyle = '#15212c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------
ui.connect.addEventListener('click', connect);
ui.disconnect.addEventListener('click', disconnect);

ui.monitor.addEventListener('click', async () => {
  monitorOn = !monitorOn;
  updateMonitorButton();
  audioIO?.setMonitor(monitorOn);
  client?.control('set-monitor', { on: monitorOn });
  await audioIO?.resume();
  log(`监听${monitorOn ? '开启' : '关闭'}`);
});

function updateMonitorButton() {
  ui.monitor.textContent = `监听：${monitorOn ? '开' : '关'}`;
  ui.monitor.classList.toggle('on', monitorOn);
}

ui.marker.addEventListener('click', () => {
  // A marker is generated on the capture side; ask the guest through the
  // feedback channel so timing reflects the real send path.
  client?.feedback({ kind: 'marker', label: 'host-request' });
  log('已请求嘉宾端发送时延标记');
});

ui.resync.addEventListener('click', () => {
  client?.control('reset');
  log('已请求重置媒体期');
});

ui.forceUnderrun.addEventListener('click', () => {
  client?.control('force-underrun');
  log('已强制触发一次欠载（测试恢复路径）');
});

$('skew-range').addEventListener('input', (e) => {
  const ppm = Number(e.target.value);
  $('skew-value').textContent = `${ppm} ppm`;
  client?.control('set-skew', { ppm });
});
$('skew-range').addEventListener('change', (e) => {
  log(`声卡时钟偏差设为 ${e.target.value} ppm（用于长时间漂移收敛测试）`);
});

$('bias-range').addEventListener('input', (e) => {
  const ms = Number(e.target.value);
  $('bias-value').textContent = `${ms} ms`;
  client?.control('set-bias', { biasMs: ms });
});

$('remote-source').addEventListener('change', (e) => {
  client?.feedback({ kind: 'set-source', source: e.target.value });
  ui.feedbackStatus.textContent = `已请求嘉宾切换到：${e.target.selectedOptions[0].textContent}`;
  log(`反馈下发来源切换：${e.target.value}`);
});

$('bitrate-range').addEventListener('input', (e) => {
  const b = Number(e.target.value);
  $('bitrate-value').textContent = `${Math.round(b / 1000)} kbps`;
});
$('bitrate-range').addEventListener('change', (e) => {
  client?.feedback({ kind: 'set-bitrate', bitrate: Number(e.target.value) });
  ui.feedbackStatus.textContent = `已下发码率 ${Math.round(Number(e.target.value) / 1000)} kbps`;
});

$('btn-apply-profile').addEventListener('click', () => {
  const key = $('remote-profile').value;
  const profile = { ...NETWORK_PROFILES[key], seed: 12345 };
  client?.feedback({ kind: 'set-profile', profile });
  ui.feedbackStatus.textContent = `已下发「${NETWORK_PROFILES[key].label}」到嘉宾端（真实注入：延迟 ${profile.baseMs} ms，抖动 ±${profile.jitterMs} ms，丢包 ${profile.lossPct}%）。`;
  log(`反馈下发网络模型：${key}`);
});

$('btn-request-marker').addEventListener('click', () => {
  client?.feedback({ kind: 'marker', label: 'remote-request' });
});

// ---------------------------------------------------------------------------
// offline simulation
// ---------------------------------------------------------------------------
ui.sim.addEventListener('click', () => {
  const key = $('sim-profile').value;
  const seconds = clamp(Number($('sim-seconds').value) || 60, 10, 600);
  client?.simulate({ seconds, profile: { ...NETWORK_PROFILES[key], seed: 2024 } });
  ui.simSummary.textContent = '模拟运行中…';
});

function renderSimulation(r) {
  if (!r) return;
  const lines = [
    `模型 ${r.profile.label || ''}，${r.seconds} s，发送 ${r.sentPackets} 包 / 送达 ${r.deliveredPackets}，丢包 ${r.dropped}（${r.lossPct?.toFixed?.(2) ?? r.lossPct}%），重复 ${r.duplicated}，乱序 ${r.reordered}。`,
    `欠载 ${r.underruns} 次；缺口 ${r.gaps} 次 / 隐藏 ${r.concealedMs} ms（${r.concealedFrames} 帧）；媒体期重建 ${r.resyncs}；晚到 ${r.late}，重复 ${r.duplicates}。`,
    `目标水位：最终 ${r.finalTargetMs} ms，区间 ${r.minTargetMs}–${r.maxTargetMs} ms，变化 ${r.targetChanges} 次；播放 ${(r.playedMs / 1000).toFixed(1)} s。`,
  ];
  ui.simSummary.innerHTML = lines.map(escapeHtml).join('<br>');
  log(`离线模拟完成：欠载 ${r.underruns}，缺口 ${r.gaps}，隐藏 ${r.concealedMs} ms，目标 ${r.minTargetMs}–${r.maxTargetMs} ms`);
}

// ---------------------------------------------------------------------------
// real signal test: pulse, speech, tone over the live link
// ---------------------------------------------------------------------------
ui.pulseTest.addEventListener('click', async () => {
  if (!client) return banner('请先建立接收连接。', 'error');
  ui.pulseTest.disabled = true;
  ui.simSummary.textContent = '真实信号测试：依次切换 持续音 → 脉冲 → 语音，每种信号采集 4 秒并打两个时延标记…';
  const results = [];
  for (const [source, label, waitMs] of [
    ['tone', '持续音 440 Hz', 4000],
    ['pulse', '脉冲 1 kHz', 4000],
    ['speech', '语音播报', 5000],
  ]) {
    const before = client.stats || {};
    client.feedback({ kind: 'set-source', source });
    await sleep(600);
    client.feedback({ kind: 'marker', label: `${source}-a` });
    await sleep(waitMs);
    const after = client.stats || {};
    const delta = {
      label,
      decoded: (after.framesDecoded || 0) - (before.framesDecoded || 0),
      concealed: (after.concealedSamples || 0) - (before.concealedSamples || 0),
      gaps: (after.gaps || 0) - (before.gaps || 0),
      underruns: (after.underruns || 0) - (before.underruns || 0),
      target: after.targetMs,
      latency: after.e2eLatencyMs,
    };
    results.push(delta);
    log(`真实测试 ${label}：解码 ${delta.decoded} 帧，隐藏 ${delta.concealed} 样本，缺口 ${delta.gaps}，欠载 ${delta.underruns}，目标 ${delta.target} ms`, delta.gaps || delta.underruns ? 'warn' : 'ok');
  }
  ui.pulseTest.disabled = false;
  const html = results
    .map((r) => `${escapeHtml(r.label)}：解码 ${r.decoded} 帧 / ${(r.decoded * 20)} ms，隐藏 ${r.concealed} 样本，缺口 ${r.gaps}，欠载 ${r.underruns}，目标 ${r.target} ms，时延 ${r.latency ? r.latency.toFixed(0) + ' ms' : '—'}`)
    .join('<br>');
  ui.simSummary.innerHTML = `<b>真实链路信号测试</b><br>${html}`;
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

ui.report.addEventListener('click', () => {
  const data = {
    at: new Date().toISOString(),
    session: $('session-name').value.trim(),
    stats: client?.stats || {},
    markers: { count: markerCount, avgMs: markerAvg, maxMs: markerMax },
    playoutSampleRate,
    history,
  };
  downloadJson(`remote-audio-host-${Date.now()}.json`, data);
});

function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

window.addEventListener('beforeunload', () => {
  client?.destroy();
  audioIO?.stop();
});
boot();
