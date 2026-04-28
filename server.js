'use strict';

const http  = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');

const PORT       = process.env.PORT     || 3001;
const API_KEY    = process.env.IF_API_KEY || '';
const API_HOST   = 'api.infiniteflight.com';
const POLL_BASE  = 15000;

// In-memory cache: flightId (string) → enriched flight object
const cache   = {};
const clients = new Set();

// ── HTTP helper ────────────────────────────────────────────────────────────────
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const fullPath = `/public/v2${path}${path.includes('?') ? '&' : '?'}apikey=${API_KEY}`;
    const req = https.get(
      { hostname: API_HOST, path: fullPath, headers: { Accept: 'application/json' } },
      res => {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('JSON parse failed')); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('request timeout')); });
  });
}

// ── Broadcast to all open clients ─────────────────────────────────────────────
function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}

// ── Poll all three IF servers ──────────────────────────────────────────────────
async function poll() {
  if (!API_KEY) {
    console.warn('[poll] IF_API_KEY not set — skipping');
    return;
  }

  try {
    const sessionsRes = await apiGet('/sessions');
    if (!Array.isArray(sessionsRes?.result)) {
      console.warn('[poll] unexpected sessions response');
      return;
    }

    const now     = Date.now();
    const updated = {};

    for (const session of sessionsRes.result) {
      const nameLower = (session.name || '').toLowerCase();
      let server = 'casual';
      if (nameLower.includes('expert'))   server = 'expert';
      else if (nameLower.includes('training')) server = 'training';

      try {
        const flightsRes = await apiGet(`/sessions/${session.id}/flights`);
        if (!Array.isArray(flightsRes?.result)) continue;

        for (const f of flightsRes.result) {
          const id = String(f.flightId);
          updated[id] = {
            flightId:            id,
            username:            f.username            || '',
            callsign:            f.callsign            || '',
            virtualOrganization: f.virtualOrganization || '',
            latitude:            f.latitude,
            longitude:           f.longitude,
            altitude:            f.altitude,
            speed:               f.speed,
            verticalSpeed:       f.verticalSpeed,
            track:               f.track,
            heading:             f.heading,
            flightState:         f.flightState,
            onGround:            f.onGround,
            server,
            serverName:          session.name,
            ts:                  now,
          };
        }
      } catch (e) {
        console.error(`[poll] session ${session.id} (${session.name}):`, e.message);
      }
    }

    // Atomically replace cache
    for (const k of Object.keys(cache)) delete cache[k];
    Object.assign(cache, updated);

    const flights = Object.values(cache);
    broadcast({ type: 'update', flights, ts: now });

    console.log(
      `[poll] ${flights.length} flights | ` +
      `${sessionsRes.result.length} sessions | ` +
      `${clients.size} client(s)`
    );
  } catch (e) {
    console.error('[poll] fatal:', e.message);
  }
}

// ── HTTP server (Railway health check) ────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Polaris IF Proxy running');
});

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  clients.add(ws);
  console.log(`[ws] client connected  (${clients.size} total)`);

  // Immediate snapshot of current cache
  ws.send(JSON.stringify({
    type:    'snapshot',
    flights: Object.values(cache),
    ts:      Date.now(),
  }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] client left  (${clients.size} remaining)`);
  });
  ws.on('error', () => clients.delete(ws));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Polaris proxy listening on :${PORT}`);
  poll();
  setInterval(() => poll(), POLL_BASE + Math.random() * 2000);
});
