import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION } from '../public/js/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// SharedArrayBuffer (used by the playout AudioWorklet) requires a
// cross-origin-isolated context.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...ISOLATION_HEADERS });
  res.end('not found');
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
    ...ISOLATION_HEADERS,
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '/guest') {
    return sendFile(res, path.join(ROOT, 'guest.html'));
  }
  if (pathname === '/host') {
    return sendFile(res, path.join(ROOT, 'host.html'));
  }
  if (pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json', ...ISOLATION_HEADERS });
    return res.end(JSON.stringify({ ok: true, sessions: sessions.size, uptimeSec: process.uptime() }));
  }
  if (pathname === '/api/sessions') {
    res.writeHead(200, { 'content-type': 'application/json', ...ISOLATION_HEADERS });
    const list = [...sessions.values()].map((s) => s.snapshot());
    return res.end(JSON.stringify({ sessions: list }));
  }

  const safe = path.normalize(pathname).replace(/^([/\\])+/, '');
  const filePath = path.join(ROOT, safe);
  if (!filePath.startsWith(ROOT + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...ISOLATION_HEADERS });
    return res.end('not found');
  }
  sendFile(res, filePath);
});

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, maxPayload: 64 * 1024 });

// ---------------------------------------------------------------------------
// Sessions: one guest + one host, keyed by a room code. A session survives a
// guest reconnect: the host stays attached and a new media period begins.
// ---------------------------------------------------------------------------
let nextPeerId = 1;

class Session {
  constructor(code) {
    this.code = code;
    this.guest = null;
    this.host = null;
    this.period = 0;
    this.createdAt = Date.now();
    this.lastGuestStats = null;
    this.lastHostStats = null;
    this.mediaPeriodInfo = null;
    this.bytesRelayed = 0;
    this.mediaPackets = 0;
    this.markers = [];
    this.controlSeq = 0;
  }

  snapshot() {
    return {
      code: this.code,
      period: this.period,
      hasGuest: !!this.guest,
      hasHost: !!this.host,
      mediaPackets: this.mediaPackets,
      bytesRelayed: this.bytesRelayed,
      guestStats: this.lastGuestStats,
      hostStats: this.lastHostStats,
      createdAt: this.createdAt,
    };
  }

  attach(ws, role, name) {
    if (role === 'guest') {
      if (this.guest && this.guest.ws !== ws && this.guest.ws.readyState === WebSocket.OPEN) {
        this.guest.ws.close(4001, 'replaced by a new guest connection');
      }
      this.guest = { ws, name, id: nextPeerId++ };
      this.period += 1;
      this.markers = [];
    } else {
      if (this.host && this.host.ws !== ws && this.host.ws.readyState === WebSocket.OPEN) {
        this.host.ws.close(4001, 'replaced by a new host connection');
      }
      this.host = { ws, name, id: nextPeerId++ };
    }
    this.broadcastPeerState();
    return this.period;
  }

  detach(ws) {
    let role = null;
    if (this.guest?.ws === ws) {
      this.guest = null;
      role = 'guest';
    }
    if (this.host?.ws === ws) {
      this.host = null;
      role = 'host';
    }
    this.broadcastPeerState();
    return role;
  }

  broadcastPeerState() {
    const state = {
      type: MSG.PEER_STATE,
      session: this.code,
      period: this.period,
      guest: this.guest ? { name: this.guest.name, id: this.guest.id } : null,
      host: this.host ? { name: this.host.name, id: this.host.id } : null,
      guestConnected: !!this.guest,
      hostConnected: !!this.host,
    };
    this.sendTo(this.guest, state);
    this.sendTo(this.host, state);
  }

  sendTo(peer, obj) {
    if (peer && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(JSON.stringify(obj));
    }
  }

  sendToRole(role, obj) {
    if (role === 'guest') this.sendTo(this.guest, obj);
    else if (role === 'host') this.sendTo(this.host, obj);
  }

  relayMedia(peer, buf, isBinary) {
    const other = peer === this.guest ? this.host : this.guest;
    if (!other || other.ws.readyState !== WebSocket.OPEN) return false;
    other.ws.send(buf, { binary: isBinary });
    this.mediaPackets++;
    this.bytesRelayed += buf.length;
    return true;
  }

  relayJson(peer, obj) {
    const other = peer === this.guest ? this.host : this.guest;
    if (!other || other.ws.readyState !== WebSocket.OPEN) return false;
    other.ws.send(JSON.stringify(obj));
    return true;
  }
}

const sessions = new Map();

function getSession(code) {
  let s = sessions.get(code);
  if (!s) {
    s = new Session(code);
    sessions.set(code, s);
  }
  return s;
}

function roleOf(session, ws) {
  if (session.guest?.ws === ws) return 'guest';
  if (session.host?.ws === ws) return 'host';
  return null;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  let session = null;
  let role = null;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (!session) {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return ws.send(JSON.stringify({ type: MSG.ERROR, message: 'bad json' }));
      }
      if (msg.type !== MSG.HELLO) {
        return ws.send(JSON.stringify({ type: MSG.ERROR, message: 'hello required' }));
      }
      const code = String(msg.session || 'studio').slice(0, 64);
      role = msg.role === 'guest' ? 'guest' : 'host';
      session = getSession(code);
      const period = session.attach(ws, role, String(msg.name || role).slice(0, 64));
      session.sendToRole(role, {
        type: MSG.WELCOME,
        version: PROTOCOL_VERSION,
        session: code,
        role,
        period,
        peerPresent: role === 'guest' ? !!session.host : !!session.guest,
      });
      return;
    }

    if (isBinary) {
      // Media packets are relayed untouched and unparsed: the relay is a wire,
      // not part of the audio path.
      session.relayMedia(role === 'guest' ? session.guest : session.host, data, true);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case MSG.MEDIA: {
        // Metadata that rides alongside a binary media packet (sent as a
        // separate small JSON message immediately before it, or used in tests).
        session.relayJson(role === 'guest' ? session.guest : session.host, msg);
        break;
      }
      case MSG.MARKER: {
        session.markers.push({ ...msg, receivedAt: Date.now() });
        if (session.markers.length > 200) session.markers.shift();
        session.relayJson(role === 'guest' ? session.guest : session.host, msg);
        break;
      }
      case MSG.STATS: {
        if (role === 'guest') session.lastGuestStats = { ...msg, receivedAt: Date.now() };
        else session.lastHostStats = { ...msg, receivedAt: Date.now() };
        session.relayJson(role === 'guest' ? session.guest : session.host, msg);
        break;
      }
      case MSG.FEEDBACK: {
        // Host -> guest: the result area's measurements must drive the guest
        // engine, not just decorate a chart.
        session.relayJson(role === 'host' ? session.host : session.guest, msg);
        break;
      }
      case MSG.CONTROL: {
        session.controlSeq++;
        session.relayJson(role === 'host' ? session.host : session.guest, { ...msg, controlSeq: session.controlSeq });
        break;
      }
      case MSG.START:
      case MSG.STOP: {
        session.relayJson(role === 'guest' ? session.guest : session.host, msg);
        break;
      }
      case MSG.PING: {
        ws.send(JSON.stringify({ type: MSG.PONG, t: msg.t }));
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!session) return;
    session.detach(ws);
    if (!session.guest && !session.host) {
      setTimeout(() => {
        if (!session.guest && !session.host && sessions.get(session.code) === session) {
          sessions.delete(session.code);
        }
      }, 60_000);
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15_000);
heartbeat.unref?.();

server.on('error', (err) => {
  console.error(`server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`remote-audio-link listening on http://${shown}:${PORT}`);
  console.log(`  host studio  http://${shown}:${PORT}/host`);
  console.log(`  remote guest http://${shown}:${PORT}/guest`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, sessions };
