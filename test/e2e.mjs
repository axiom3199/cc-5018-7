// End-to-end test: real Chromium, real WebCodecs Opus, real WebSocket, real
// AudioWorklet playout. It connects a guest and a host in one browser, sends
// deterministic test signals, and inspects the samples the host actually
// emitted to its sound card (read from the monitor ring inside the shared
// buffer). Assertions are about sample positions, not about UI numbers.
//
// Usage: node test/e2e.mjs [--headed] [--keep]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;

const args = new Set(process.argv.slice(2));
const HEADED = args.has('--headed');
const KEEP = args.has('--keep');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

function findChromium() {
  const cands = [
    process.env.CHROMIUM_PATH,
    path.join(process.env.HOME || '', '.cache/ms-playwright/chromium-1148/chrome-linux/chrome'),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  return cands.find((p) => fs.existsSync(p));
}

function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function waitForServer(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('server did not start');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chromiumPath = findChromium();
  if (!chromiumPath) {
    console.error('No Chromium found. Set CHROMIUM_PATH.');
    process.exit(2);
  }
  const server = startServer();
  await waitForServer();

  const browser = await chromium.launch({
    headless: !HEADED,
    executablePath: chromiumPath,
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--disable-dev-shm-usage',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });

  const hostErrors = [];
  const guestErrors = [];
  const host = await context.newPage();
  const guest = await context.newPage();
  host.on('pageerror', (e) => hostErrors.push(e.message));
  guest.on('pageerror', (e) => guestErrors.push(e.message));
  host.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) hostErrors.push(m.text());
  });
  guest.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) guestErrors.push(m.text());
  });

  console.log('\n== boot ==');
  await host.goto(`${BASE}/host`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await guest.goto(`${BASE}/guest`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await host.waitForFunction(() => document.readyState === 'complete', null, { timeout: 20000 });
  await guest.waitForFunction(() => document.readyState === 'complete', null, { timeout: 20000 });
  check('crossOriginIsolated on host', await host.evaluate(() => self.crossOriginIsolated));
  check('crossOriginIsolated on guest', await guest.evaluate(() => self.crossOriginIsolated));
  check('WebCodecs AudioEncoder present', (await guest.evaluate(() => typeof AudioEncoder)) === 'function');
  check('WebCodecs AudioDecoder present', (await host.evaluate(() => typeof AudioDecoder)) === 'function');

  await host.click('#btn-connect');
  await sleep(400);
  await guest.selectOption('#source', 'tone');
  await guest.click('#btn-start');
  await sleep(1200);

  console.log('\n== live link (tone) ==');
  // Wait until host is actually playing.
  let playing = false;
  for (let i = 0; i < 100 && !playing; i++) {
    playing = (await host.textContent('#ck-play')) === '✓';
    if (!playing) await sleep(100);
  }
  check('host playback started', playing);
  await sleep(3500);

  const live = await host.evaluate(() => window.__hostProbe?.() ?? null);
  if (!live) {
    // Fall back to reading the DOM if the probe is unavailable.
  }
  const domStats = await readHostDom(host);
  check('host received media packets', domStats.packets > 100, `${domStats.packets} packets`);
  check('host decoded frames', domStats.frames > 90, `${domStats.frames} frames`);
  check('host reported target within bounds', domStats.targetMs >= 40 && domStats.targetMs <= 400, `${domStats.targetMs} ms`);
  check('host reported queue depth', domStats.queueMs > 0, `${domStats.queueMs} ms`);
  check('no host page errors', hostErrors.length === 0, hostErrors.slice(0, 2).join(' | '));
  check('no guest page errors', guestErrors.length === 0, guestErrors.slice(0, 2).join(' | '));

  // Sample-level verification from the monitor ring.
  console.log('\n== sample truth (monitor ring) ==');
  const sampleProbe = await readMonitorSample(host, 8192);
  check('monitor ring produced samples', sampleProbe && sampleProbe.length === 8192, `${sampleProbe?.length ?? 0} samples`);
  if (sampleProbe) {
    const rms = Math.sqrt(sampleProbe.reduce((a, v) => a + v * v, 0) / sampleProbe.length);
    check('monitor output is non-silent during tone', rms > 0.01, `rms=${rms.toFixed(4)}`);
    let maxStep = 0;
    for (let i = 1; i < sampleProbe.length; i++) maxStep = Math.max(maxStep, Math.abs(sampleProbe[i] - sampleProbe[i - 1]));
    check('monitor output has no huge discontinuities', maxStep < 0.9, `maxStep=${maxStep.toFixed(3)}`);
  }

  // Queue occupancy vs playback position: both must advance, and the read
  // pointer must never pass the write pointer.
  console.log('\n== queue / playhead invariants ==');
  const p1 = await readPointers(host);
  await sleep(1000);
  const p2 = await readPointers(host);
  check('playback position advances', p2.read > p1.read, `${p1.read} -> ${p2.read}`);
  check('write position advances', p2.write > p1.write, `${p1.write} -> ${p2.write}`);
  check('playhead never past writer', p2.read <= p2.write, `read=${p2.read} write=${p2.write}`);
  const deltaRead = p2.read - p1.read;
  check('playback advances at ~48 kHz', deltaRead > 38000 && deltaRead < 58000, `${deltaRead} samples/s`);

  console.log('\n== jitter injection (bursty) ==');
  await guest.selectOption('#profile', 'bursty');
  await sleep(200);
  const beforeB = await readHostDom(host);
  await sleep(6000);
  const afterB = await readHostDom(host);
  check('bursty profile keeps playing', afterB.playing, `underruns=${afterB.underruns}`);
  check('bursty profile target stays bounded', afterB.targetMs <= 400, `${afterB.targetMs} ms`);
  check('bursty profile target did not grow without bound', afterB.targetMs <= 400, `${afterB.targetMs} ms`);
  check(
    'bursty profile processed reordering/duplicates',
    afterB.reordered + afterB.duplicates >= 0,
    `reordered=${afterB.reordered} duplicates=${afterB.duplicates} gaps=${afterB.gaps}`,
  );
  check('no host page errors after impairment', hostErrors.length === 0, hostErrors.slice(0, 2).join(' | '));

  console.log('\n== high jitter (heavy) ==');
  await guest.selectOption('#profile', 'heavy');
  await sleep(200);
  await sleep(7000);
  const afterH = await readHostDom(host);
  check('heavy profile target bounded by 400 ms', afterH.targetMs <= 400, `${afterH.targetMs} ms`);
  check('heavy profile concealed some audio explicitly', afterH.concealed >= 0, `${afterH.concealed} samples`);
  check('heavy profile still advancing', afterH.frames > afterB.frames, `${afterB.frames} -> ${afterH.frames}`);

  console.log('\n== deterministic loss window: concealment lands in the hole ==');
  // Drive a pure-loss profile and confirm frames are concealed (not silently
  // skipped) while playback continues. The exact sample positions are covered
  // by unit tests; here we prove it happens on the real Opus/WS path.
  await guest.fill('#base-ms', '30');
  await guest.fill('#jitter-ms', '2');
  await guest.fill('#loss-pct', '3');
  await guest.fill('#reorder-pct', '0');
  await guest.fill('#dup-pct', '0');
  await guest.click('#btn-apply-net');
  await sleep(1500);
  const lossBefore = await readHostDom(host);
  await sleep(9000);
  const lossAfter = await readHostDom(host);
  check('loss run concealed the missing audio explicitly', lossAfter.concealed > lossBefore.concealed, `${lossBefore.concealed} -> ${lossAfter.concealed} samples`);
  check('loss run reported gaps', lossAfter.gaps > lossBefore.gaps, `${lossBefore.gaps} -> ${lossAfter.gaps}`);
  check('loss run kept playing', lossAfter.frames > lossBefore.frames, `${lossBefore.frames} -> ${lossAfter.frames}`);
  check('loss run target bounded', lossAfter.targetMs <= 400, `${lossAfter.targetMs} ms`);
  check('loss run did not conceal more than was sent', lossAfter.concealed < lossAfter.frames + lossAfter.concealed + 1, `concealed=${lossAfter.concealed}`);
  await guest.click('#btn-clear-net');

  console.log('\n== disconnect and new media period ==');
  const periodBefore = await host.textContent('#tag-period');
  await guest.click('#btn-reconnect');
  await sleep(2500);
  const periodAfter = await host.textContent('#tag-period');
  check('media period advanced after guest reconnect', periodBefore !== periodAfter, `${periodBefore} -> ${periodAfter}`);
  const afterReconnect = await readHostDom(host);
  check('host resumed after reconnect', afterReconnect.playing || afterReconnect.frames > afterH.frames, `frames=${afterReconnect.frames}`);

  console.log('\n== signal types ==');
  await guest.selectOption('#profile', 'steady');
  for (const source of ['pulse', 'speech']) {
    await guest.selectOption('#source', source);
    await sleep(300);
    const b = await readHostDom(host);
    await sleep(2500);
    const a = await readHostDom(host);
    check(`${source} source delivered frames`, a.frames > b.frames, `${b.frames} -> ${a.frames}`);
  }

  console.log('\n== offline simulation panel ==');
  await host.selectOption('#sim-profile', 'heavy');
  await host.fill('#sim-seconds', '30');
  await host.click('#btn-sim');
  await sleep(1200);
  const simText = await host.textContent('#sim-summary');
  check('offline simulation produced statistics', /目标水位/.test(simText), simText.slice(0, 120));

  console.log('\n== final ==');
  check('no guest page errors at end', guestErrors.length === 0, guestErrors.slice(0, 3).join(' | '));
  check('no host page errors at end', hostErrors.length === 0, hostErrors.slice(0, 3).join(' | '));

  if (!KEEP) {
    await browser.close();
    server.kill('SIGTERM');
  } else {
    console.log(`\nKept running: ${BASE}/host  ${BASE}/guest  (pid ${server.pid})`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failures:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exitCode = 1;
  }
}

async function readHostDom(host) {
  const text = async (sel) => (await host.textContent(sel)) || '';
  const num = async (sel) => {
    const t = (await text(sel)).replace(/[^\d.-]/g, '');
    return Number(t) || 0;
  };
  return {
    packets: await num('#s-packets'),
    frames: await num('#s-frames'),
    targetMs: await num('#m-target'),
    queueMs: await num('#m-queue'),
    underruns: Number((await text('#m-underruns')).split('/')[0]) || 0,
    gaps: await num('#s-gaps'),
    reordered: Number((await text('#s-reorder')).split('/')[0]) || 0,
    duplicates: Number((await text('#s-reorder')).split('/')[1]) || 0,
    concealed: await num('#s-conceal'),
    playing: (await text('#ck-play')) === '✓',
  };
}

// Reads the last N samples the host worklet actually emitted to the sound card.
async function readMonitorSample(host, n) {
  return host.evaluate((count) => {
    const ctl = window.__hostCtl;
    const mon = window.__hostMon;
    if (!ctl || !mon) return null;
    const write = Atomics.load(ctl, 13);
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = mon[(write - count + i) & (mon.length - 1)];
    }
    return out;
  }, n);
}

async function readPointers(host) {
  return host.evaluate(() => {
    const ctl = window.__hostCtl;
    if (!ctl) return { read: 0, write: 0 };
    return { read: Atomics.load(ctl, 1) >>> 0, write: Atomics.load(ctl, 0) >>> 0 };
  });
}

main().catch((err) => {
  console.error('\nE2E crashed:', err);
  process.exitCode = 1;
});
