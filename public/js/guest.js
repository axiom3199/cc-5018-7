import { RemoteAudioClient } from './client.js';
import { GuestAudioIO } from './audio-io.js';
import { NETWORK_PROFILES } from './protocol.js';

const $ = (id) => document.getElementById(id);

const ui = {
  start: $('btn-start'),
  stop: $('btn-stop'),
  reconnect: $('btn-reconnect'),
  download: $('btn-download'),
  marker: $('btn-marker'),
  applyNet: $('btn-apply-net'),
  clearNet: $('btn-clear-net'),
  underrun: $('btn-underrun-test'),
  banner: $('banner'),
  log: $('event-log'),
  meter: $('meter'),
  dotWs: $('dot-ws'),
  txtWs: $('txt-ws'),
  dotTx: $('dot-tx'),
  txtTx: $('txt-tx'),
  dotCrypto: $('dot-crypto'),
  txtCrypto: $('txt-crypto'),
  tagPeriod: $('tag-period'),
  tagFormat: $('tag-format'),
  tagImpair: $('tag-impair'),
  negotiation: $('negotiation'),
  feedback: $('feedback-status'),
};

let client = null;
let audio = null;
let peakHistory = new Float32Array(512);
let peakWrite = 0;
let running = false;
let profile = { ...NETWORK_PROFILES.steady };
let lastE2e = null;

function boot() {
  const isolated = self.crossOriginIsolated;
  ui.dotCrypto.className = `dot ${isolated ? 'ok' : 'bad'}`;
  ui.txtCrypto.textContent = isolated ? '跨源隔离已启用' : '缺少跨源隔离';
  $('ck-isolation').textContent = isolated ? '✓' : '✕';
  $('ck-isolation').className = `mark ${isolated ? 'ok' : 'bad'}`;
  const enc = typeof AudioEncoder !== 'undefined';
  $('ck-enc').textContent = enc ? '✓' : '✕';
  $('ck-enc').className = `mark ${enc ? 'ok' : 'bad'}`;
  const cap = typeof AudioWorkletNode !== 'undefined';
  $('ck-capture').textContent = cap ? '✓' : '✕';
  $('ck-capture').className = `mark ${cap ? 'ok' : 'bad'}`;
  drawMeter();
  requestAnimationFrame(renderLoop);
  syncProfileInputs();
}

function log(text, kind = '') {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">${t}</span> <span class="${kind}">${escapeHtml(text)}</span>`;
  ui.log.prepend(line);
  while (ui.log.childElementCount > 120) ui.log.lastChild.remove();
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function banner(text, kind = '') {
  ui.banner.textContent = text;
  ui.banner.className = `banner ${kind}`;
  ui.banner.classList.remove('hidden');
}

async function start() {
  const source = $('source').value;
  ui.start.disabled = true;
  banner('正在请求音频设备并启动编码…', '');
  try {
    client = new RemoteAudioClient({ onEvent });
    await client.init('guest', {
      session: $('session-name').value.trim() || 'studio',
      name: navigator.platform ? `guest (${navigator.platform})` : 'guest',
      source,
      profile,
      bitrate: 64000,
    });

    // The page owns the sound card; the kernel only encodes what it is given.
    audio = new GuestAudioIO({
      onFrame: (frame) => client?.captureFrame(frame),
      onLevel: (m) => client?.captureLevel(m.peak, m.chunkIndex),
      onReady: (info) => client?.audioReady(info),
    });
    const info = await audio.start({
      source,
      speechUrl: '/assets/guest-speech.wav',
      gain: 0.35,
    });
    client.audioReady(info);
    if (info.speechSeconds) postSpeech(info);

    running = true;
    ui.stop.disabled = false;
    ui.reconnect.disabled = false;
    ui.download.disabled = false;
    ui.marker.disabled = false;
    ui.underrun.disabled = false;
    ui.tagFormat.textContent = `Opus 48 kHz · ${sourceLabel(source)}`;
    if (source === 'mic') setMark('ck-mic', true);
  } catch (err) {
    ui.start.disabled = false;
    banner(`启动失败：${err.message}`, 'error');
    log(`启动失败：${err.message}`, 'bad');
    setMark('ck-mic', false);
    cleanupAudio();
  }
}

function postSpeech(info) {
  log(`语音素材加载完成：${info.speechSeconds.toFixed(1)} s @ ${info.speechRate} Hz`, 'ok');
}

function cleanupAudio() {
  audio?.stop();
  audio = null;
}

function sourceLabel(s) {
  return {
    tone: '持续音',
    pulse: '脉冲',
    speech: '语音',
    mic: '麦克风',
  }[s] || s;
}

function stop() {
  client?.destroy();
  client = null;
  cleanupAudio();
  running = false;
  ui.start.disabled = false;
  ui.stop.disabled = true;
  ui.reconnect.disabled = true;
  ui.download.disabled = true;
  ui.marker.disabled = true;
  ui.underrun.disabled = true;
  setWs(false, '未连接');
  setTx(false, '未发送');
  banner('已停止发送。', '');
  log('已停止发送并关闭音频设备');
}

function onEvent(type, payload) {
  switch (type) {
    case 'ws-open':
      setWs(true, '已连接');
      setMark('ck-ws', true);
      log('WebSocket 已连接，注册为 guest', 'ok');
      break;
    case 'ws-close':
      setWs(false, '连接断开');
      setMark('ck-ws', false);
      log('WebSocket 断开；可点击「断线重连」开始新媒体期', 'warn');
      break;
    case 'welcome':
      ui.tagPeriod.textContent = `媒体期 ${payload.period}`;
      log(`服务端确认：会话 ${payload.session}，媒体期 ${payload.period}`, 'ok');
      banner(payload.peerPresent ? '主持端在线，正在发送音频。' : '已连接中继；请打开主持端页面。', payload.peerPresent ? 'ok' : '');
      setTx(true, '发送中');
      if ($('source').value === 'mic') setMark('ck-mic', true);
      break;
    case 'peer-state':
      ui.tagPeriod.textContent = `媒体期 ${payload.period}`;
      log(payload.hostConnected ? '主持端在线' : '主持端离线（仍将保留发送，等待其回来）', payload.hostConnected ? 'ok' : 'warn');
      break;
    case 'negotiation':
      renderNegotiation(payload);
      if (payload.negotiation) renderNegotiation(payload.negotiation);
      break;
    case 'state':
      if (payload.stats?.negotiation) renderNegotiation(payload.stats.negotiation);
      break;
    case 'speech-loaded':
      log(`语音素材加载完成：${payload.seconds.toFixed(1)} s @ ${payload.sampleRate} Hz`, 'ok');
      break;
    case 'capture-level':
      peakHistory[peakWrite & (peakHistory.length - 1)] = payload.peak;
      peakWrite++;
      break;
    case 'marker-echo':
      lastE2e = payload;
      $('m-e2e').innerHTML = `${payload.e2eMs.toFixed(1)}<small> ms</small>`;
      log(`标记回传：RTT ${payload.rttMs.toFixed(1)} ms，缓冲 ${payload.bufferMs?.toFixed?.(1) ?? '—'} ms，估算端到端 ${payload.e2eMs.toFixed(1)} ms`, 'ok');
      break;
    case 'controldone':
    case 'control':
      log(`内核控制：${payload.action || payload.kind || ''}`);
      break;
    case 'marker-request':
      // Kernel wants a marker on the next captured block; the page owns the
      // capture worklet, so it injects the marker there.
      audio?.marker(payload.markerId || `m${Date.now()}`, payload.label || 'marker');
      break;
    case 'source': {
      const next = payload.source;
      $('source').value = next;
      ui.tagFormat.textContent = `Opus 48 kHz · ${sourceLabel(next)}`;
      if (audio) {
        audio
          .setSource(next, '/assets/guest-speech.wav')
          .then((info) => info && client?.audioReady(info))
          .catch((err) => {
            log(`切换来源失败：${err.message}`, 'bad');
            ui.feedback.textContent = `切换来源失败：${err.message}`;
          });
      }
      log(`来源已切换到 ${sourceLabel(next)}`, 'ok');
      break;
    }
    case 'profile':
      ui.tagImpair.textContent = fmtProfile(payload.profile);
      break;
    case 'bitrate':
      log(`码率已调整为 ${Math.round(payload.bitrate / 1000)} kbps`);
      break;
    case 'feedback':
      handleFeedback(payload);
      break;
    case 'host-result':
      if (payload.event === 'underrun') {
        ui.feedback.textContent = `主持端报告欠载 #${payload.count}，其目标水位升到 ${payload.targetMs} ms`;
        log(`主持端结果回传：欠载 #${payload.count}，目标 ${payload.targetMs} ms`, 'warn');
      } else if (payload.event === 'conceal') {
        ui.feedback.textContent = `主持端隐藏了 ${payload.frames} 帧缺失音频（${payload.reason}）`;
        log(`主持端结果回传：隐藏 ${payload.frames} 帧（${payload.reason}）`, 'warn');
      }
      break;
    case 'underrun':
      log(`主持端报告欠载 #${payload.count}，其目标水位升到 ${payload.targetMs} ms`, 'warn');
      ui.feedback.textContent = `主持端报告欠载 #${payload.count}，目标 ${payload.targetMs} ms`;
      break;
    case 'error':
      log(`内核错误：${payload.message}`, 'bad');
      banner(`远程音频错误：${payload.message}`, 'error');
      ui.feedback.textContent = `失败：${payload.message}`;
      break;
    case 'stats':
      if (payload.stats) applyStats(payload.stats);
      break;
    case 'simulation':
      break;
    default:
      break;
  }
}

function handleFeedback(msg) {
  // Host-driven controls reach the guest kernel, which applies them for real.
  if (msg.kind === 'set-profile' && msg.profile) {
    profile = { ...profile, ...msg.profile };
    syncProfileInputs();
    ui.tagImpair.textContent = fmtProfile(profile);
    ui.feedback.textContent = `主持端下发网络模型：延迟 ${profile.baseMs} ms，抖动 ±${profile.jitterMs} ms，丢包 ${profile.lossPct}%`;
    log('主持端下发网络注入模型，已应用', 'ok');
  } else if (msg.kind === 'set-source' && msg.source) {
    $('source').value = msg.source;
    ui.tagFormat.textContent = `Opus 48 kHz · ${sourceLabel(msg.source)}`;
    ui.feedback.textContent = `主持端请求来源切换：${sourceLabel(msg.source)}`;
    log(`主持端下发来源切换：${msg.source}`, 'ok');
  } else if (msg.kind === 'set-bitrate') {
    ui.feedback.textContent = `主持端下发码率：${Math.round(msg.bitrate / 1000)} kbps`;
    log(`主持端下发码率 ${Math.round(msg.bitrate / 1000)} kbps`);
  } else if (msg.kind === 'marker') {
    client?.marker(msg.label || 'host-request');
    log('主持端请求时延标记，已发送');
  }
}

function renderNegotiation(n) {
  const bits = [];
  if (n.contextRate) bits.push(`AudioContext ${n.contextRate} Hz`);
  if (n.captureRate) bits.push(`采集 ${n.captureRate} Hz`);
  if (n.opusEncoder) bits.push('Opus 编码器');
  if (n.mic) bits.push(`麦克风：${n.mic}`);
  if (n.micSettings?.sampleRate) bits.push(`设备请求 ${n.micSettings.sampleRate} Hz`);
  if (n.speechSeconds) bits.push(`语音素材 ${n.speechSeconds.toFixed(1)} s`);
  if (n.bitrate) bits.push(`码率 ${Math.round(n.bitrate / 1000)} kbps`);
  if (bits.length) ui.negotiation.textContent = `协商信息：${bits.join(' · ')}`;
  if (n.opusEncoder) setMark('ck-enc', true);
  if (n.captureRate) setMark('ck-capture', true);
}

function applyStats(s) {
  const captured = s.framesCaptured ?? 0;
  $('m-captured').textContent = captured.toLocaleString('en-US');
  $('m-encoded').textContent = (s.framesEncoded ?? 0).toLocaleString('en-US');
  $('m-sent').textContent = (s.packetsSent ?? 0).toLocaleString('en-US');
  $('m-bytes').textContent = fmtBytes(s.bytesSent);
  $('m-enc-err').textContent = s.encodeErrors ?? 0;
  if (s.impairment) ui.tagImpair.textContent = fmtProfile({ ...s.impairment });
}

function fmtProfile(p) {
  if (!p) return '—';
  const bits = [];
  if (p.baseMs !== undefined) bits.push(`延迟 ${p.baseMs} ms`);
  if (p.jitterMs !== undefined) bits.push(`抖动 ±${p.jitterMs} ms`);
  if (p.lossPct !== undefined) bits.push(`丢包 ${p.lossPct}%`);
  if (p.reorderPct) bits.push(`乱序 ${p.reorderPct}%`);
  if (p.dupPct) bits.push(`重复 ${p.dupPct}%`);
  return bits.join(' · ') || '干净';
}

function fmtBytes(b) {
  const n = Number(b || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function setWs(ok, text) {
  ui.dotWs.className = `dot ${ok ? 'ok' : 'bad'}`;
  ui.txtWs.textContent = text;
}
function setTx(ok, text) {
  ui.dotTx.className = `dot ${ok ? 'ok' : 'bad'}`;
  ui.txtTx.textContent = text;
}
function setMark(id, ok) {
  const el = $(id);
  el.textContent = ok ? '✓' : '✕';
  el.className = `mark ${ok ? 'ok' : 'bad'}`;
}

// ---------------------------------------------------------------------------
// meter
// ---------------------------------------------------------------------------
function renderLoop() {
  requestAnimationFrame(renderLoop);
  drawMeter();
}

function drawMeter() {
  const canvas = ui.meter;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#15212c';
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h / 4) * i);
    ctx.lineTo(w, (h / 4) * i);
    ctx.stroke();
  }
  const n = peakHistory.length;
  ctx.beginPath();
  ctx.strokeStyle = '#26d39b';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < n; i++) {
    const v = peakHistory[(peakWrite + i) & (n - 1)];
    const x = (i / (n - 1)) * w;
    const y = h - 4 - v * (h - 10);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  const latest = peakHistory[(peakWrite - 1) & (n - 1)] || 0;
  ctx.fillStyle = latest > 0.98 ? '#ff5d5d' : '#5f7386';
  ctx.font = `${11 * dpr}px ui-monospace, monospace`;
  ctx.fillText(`peak ${(20 * Math.log10(latest + 1e-9)).toFixed(1)} dBFS`, 8 * dpr, 14 * dpr);
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------
ui.start.addEventListener('click', start);
ui.stop.addEventListener('click', stop);

ui.reconnect.addEventListener('click', () => {
  client?.reconnect({
    session: $('session-name').value.trim() || 'studio',
    name: 'guest',
    role: 'guest',
  });
  log('正在重连：主持端将看到旧媒体期结束并开始新媒体期', 'warn');
});

ui.marker.addEventListener('click', () => {
  client?.marker('manual');
  log('已发送时延标记');
});

ui.underrun.addEventListener('click', () => {
  client?.feedback({ kind: 'force-underrun' });
  log('已请求主持端强制欠载（用于验证恢复路径）');
});

ui.applyNet.addEventListener('click', () => {
  profile = readProfileInputs();
  ui.tagImpair.textContent = fmtProfile(profile);
  client?.control('set-profile', { profile });
  log(`已应用本机损伤：${fmtProfile(profile)}`, 'ok');
});
ui.clearNet.addEventListener('click', () => {
  profile = { ...NETWORK_PROFILES.clean, seed: 1 };
  syncProfileInputs();
  ui.tagImpair.textContent = fmtProfile(profile);
  client?.control('set-profile', { profile });
  log('已恢复干净链路', 'ok');
});

$('profile').addEventListener('change', (e) => {
  const base = NETWORK_PROFILES[e.target.value];
  if (!base) return;
  profile = { ...base, seed: 12345 };
  syncProfileInputs();
  ui.tagImpair.textContent = fmtProfile(profile);
  if (running) client?.control('set-profile', { profile });
});

function readProfileInputs() {
  return {
    baseMs: clampNum($('base-ms').value, 0, 1000),
    jitterMs: clampNum($('jitter-ms').value, 0, 300),
    lossPct: clampNum($('loss-pct').value, 0, 50),
    reorderPct: clampNum($('reorder-pct').value, 0, 50),
    dupPct: clampNum($('dup-pct').value, 0, 50),
    seed: 12345,
  };
}

function syncProfileInputs() {
  $('base-ms').value = profile.baseMs ?? 0;
  $('jitter-ms').value = profile.jitterMs ?? 0;
  $('loss-pct').value = profile.lossPct ?? 0;
  $('reorder-pct').value = profile.reorderPct ?? 0;
  $('dup-pct').value = profile.dupPct ?? 0;
}

function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

ui.download.addEventListener('click', () => {
  const data = {
    at: new Date().toISOString(),
    session: $('session-name').value.trim(),
    source: $('source').value,
    profile,
    stats: client?.stats || {},
    lastMarkerEcho: lastE2e,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `remote-audio-guest-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

window.addEventListener('beforeunload', () => {
  client?.destroy();
  audio?.stop();
});
boot();
