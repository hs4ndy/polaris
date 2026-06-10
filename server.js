'use strict';

const http  = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');

const PORT       = process.env.PORT       || 3001;
const API_KEY    = process.env.IF_API_KEY || '';
const API_HOST   = process.env.IF_API_HOST || 'api.infiniteflight.com';
const POLL_BASE  = 15000;

// Allowed browser origins for CORS. Comma-separated env override, else a
// sensible default set (prod Vercel domain + localhost for dev). '*' is the
// final fallback so the app keeps working if ALLOWED_ORIGINS isn't configured.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// In-memory cache: flightId (string) → enriched flight object
const cache         = {};
const clients       = new Set();
let   lastPollTs    = 0;      // when the last successful poll completed
let   pollIdleLogged = false; // one-shot "paused" log so we don't spam every 15 s
let   aircraftNames = {};   // aircraftId (GUID) → human-readable name, e.g. "Airbus A320"
let   liveryNames   = {};   // liveryId  (GUID) → human-readable livery, e.g. "American Airlines"

// ── Security: per-IP rate limiting ──────────────────────────────────────────────
//  Fixed-window counter. Cheap, in-memory, no deps. Tuned generously enough
//  for normal browsing (a session clicks a handful of flights/min) but low
//  enough to make brute-forcing the /path & /flightplan endpoints impractical.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HTTP  = 100;          // HTTP requests / IP / minute
const WS_MAX_PER_IP  = 8;            // concurrent WebSocket connections / IP
const rateBuckets    = new Map();    // ip → { count, resetAt }
const wsCountByIp    = new Map();    // ip → active WS connection count

function clientIp(req) {
  // Render/Vercel/most proxies put the real client IP first in x-forwarded-for
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimitOk(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, b);
  }
  b.count++;
  return b.count <= RATE_MAX_HTTP;
}

// Periodic cleanup so the bucket maps don't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) if (now >= b.resetAt) rateBuckets.delete(ip);
}, 5 * 60_000).unref?.();

// ── Security: input validation ──────────────────────────────────────────────────
//  IF flight IDs are GUIDs. Accept only safe URL-segment characters and cap the
//  length hard so a malformed/oversized param can never reach the upstream API
//  or be used to build a weird request path.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isValidId = id => typeof id === 'string' && ID_RE.test(id);

const MAX_URL_LEN = 256;   // reject absurdly long request targets outright

// Rolling path history per flight — keeps up to ~30 min so client can fetch
// a full trail the instant a user clicks a plane, instead of waiting for
// liveTrails to accumulate.
//   pathHistory[flightId] = [{lat, lng, alt, spd, vs, track, ts}, ...]
const pathHistory   = {};
const PATH_MAX_PTS  = 120;        // 30 min at 15 s polls
const PATH_MIN_DLAT = 1e-5;       // ~1 m — skip duplicate positions
const PATH_MIN_DLNG = 1e-5;

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

// ── Aircraft + livery metadata (fetched at boot, refreshed every 6 h) ─────────
//  GET /liveries returns one row per livery, each carrying BOTH the aircraft
//  type (aircraftID + aircraftName) and the livery (id + liveryName, which is
//  usually the airline, e.g. "American Airlines"). So a single call populates
//  both maps. /aircraft is a fallback only if /liveries fails to give us types.
async function refreshMeta() {
  if (!API_KEY) return;

  try {
    const res  = await apiGet('/liveries');
    const list = Array.isArray(res?.result) ? res.result : [];
    for (const l of list) {
      const acId = l.aircraftID || l.aircraftId;
      const acNm = l.aircraftName || l.aircraft;
      const lvId = l.id || l.liveryID || l.liveryId;
      const lvNm = l.liveryName || l.livery || l.name;
      if (acId && acNm) aircraftNames[acId] = acNm;
      if (lvId && lvNm) liveryNames[lvId]   = lvNm;
    }
    console.log(`[meta] /liveries: ${list.length} rows → ${Object.keys(aircraftNames).length} aircraft, ${Object.keys(liveryNames).length} liveries`);
  } catch (e) {
    console.error('[meta] /liveries failed:', e.message);
  }

  // Fallback: populate aircraft names from /aircraft if liveries gave us none
  if (Object.keys(aircraftNames).length === 0) {
    try {
      const res  = await apiGet('/aircraft');
      const list = Array.isArray(res?.result) ? res.result : [];
      for (const a of list) {
        const id = a.id || a.aircraftID || a.aircraftId;
        const nm = a.name || a.aircraftName;
        if (id && nm) aircraftNames[id] = nm;
      }
      console.log(`[meta] /aircraft fallback: ${Object.keys(aircraftNames).length} aircraft names`);
    } catch (e) {
      console.error('[meta] /aircraft fallback failed:', e.message);
    }
  }
}

// One-shot diagnostic: log the field shape of the first flight we ever see.
// Helps us discover whether IF returns aircraftId or aircraftID, and what other
// fields exist that we could pass through.
let _loggedSampleFlight = false;

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

  // Per Infinite Flight's request: don't hit their API when nobody is
  // watching. Polling resumes instantly when a client connects (see the
  // wss connection handler, which calls poll() if the cache is stale).
  if (clients.size === 0) {
    if (!pollIdleLogged) {
      console.log('[poll] paused — no connected clients');
      pollIdleLogged = true;
    }
    return;
  }
  pollIdleLogged = false;

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

          // First-flight diagnostic — log keys + relevant IDs once per process
          if (!_loggedSampleFlight) {
            _loggedSampleFlight = true;
            console.log('[diag] sample flight keys:', Object.keys(f));
            console.log('[diag] sample IDs:', {
              aircraftId:  f.aircraftId,
              aircraftID:  f.aircraftID,
              liveryId:    f.liveryId,
              liveryID:    f.liveryID,
              callsign:    f.callsign,
            });
          }

          // The IF Live API uses inconsistent casing across endpoints — accept both
          const acId = f.aircraftId || f.aircraftID || '';
          const lvId = f.liveryId   || f.liveryID   || '';
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
            aircraft:            aircraftNames[acId] || '',
            livery:              liveryNames[lvId]   || '',
            server,
            serverName:          session.name,
            sessionId:           session.id,            // needed for flightplan lookup
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

    // Append each flight's current position to its rolling path history.
    // Skip the append if it hasn't moved meaningfully (parked planes, etc.).
    for (const [id, f] of Object.entries(updated)) {
      if (f.latitude == null || f.longitude == null) continue;
      const hist = pathHistory[id] || (pathHistory[id] = []);
      const last = hist[hist.length - 1];
      if (!last
          || Math.abs(last.lat - f.latitude)  >= PATH_MIN_DLAT
          || Math.abs(last.lng - f.longitude) >= PATH_MIN_DLNG) {
        hist.push({
          lat:   f.latitude,
          lng:   f.longitude,
          alt:   f.altitude,
          spd:   f.speed,
          vs:    f.verticalSpeed,
          track: f.track,
          ts:    f.ts,
        });
        if (hist.length > PATH_MAX_PTS) hist.shift();
      }
    }
    // Drop history for flights that disappeared this poll
    for (const id of Object.keys(pathHistory)) {
      if (!updated[id]) delete pathHistory[id];
    }

    const flights = Object.values(cache);
    lastPollTs = now;
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

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // ── CORS ── allow configured origins (or * if none configured)
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length && origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!ALLOWED_ORIGINS.length) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ── Method allow-list — this proxy is read-only ──
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  // ── Reject oversized / malformed request targets before any work ──
  if (!req.url || req.url.length > MAX_URL_LEN) {
    res.writeHead(414, { 'Content-Type': 'text/plain' });
    res.end('URI too long');
    return;
  }

  // ── Per-IP rate limit ──
  const ip = clientIp(req);
  if (!rateLimitOk(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
    res.end('Too many requests');
    return;
  }

  // Health check
  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Polaris IF Proxy running');
    return;
  }

  // Full flown track: GET /path/:flightId
  // Hits the IF Live API /sessions/{sid}/flights/{fid}/route endpoint to get
  // the ENTIRE flight history (from takeoff or earlier), then merges any
  // newer rolling pathHistory entries we've collected since the last API
  // sample. Falls back to pure pathHistory on error.
  const pathMatch = req.url.match(/^\/path\/([^/?]+)/);
  if (pathMatch) {
    const flightId = decodeURIComponent(pathMatch[1]);
    if (!isValidId(flightId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid flight id' }));
      return;
    }
    const cached   = cache[flightId];
    const local    = pathHistory[flightId] || [];

    if (!cached || !cached.sessionId) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: local }));
      return;
    }

    try {
      const data = await apiGet(`/sessions/${cached.sessionId}/flights/${flightId}/route`);
      const apiPts = Array.isArray(data?.result) ? data.result : [];

      // Normalize to our internal shape
      const fromApi = apiPts.map(p => ({
        lat:   p.latitude,
        lng:   p.longitude,
        alt:   p.altitude,
        spd:   p.groundSpeed,
        track: p.track,
        ts:    new Date(p.date).getTime(),
      })).filter(p =>
        Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.ts)
      ).sort((a, b) => a.ts - b.ts);

      // Append any rolling entries strictly newer than the API's last sample
      const lastApiTs = fromApi.length ? fromApi[fromApi.length - 1].ts : 0;
      const newer     = local.filter(p => p.ts > lastApiTs);
      const merged    = fromApi.concat(newer);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: merged }));
    } catch (e) {
      // On error fall back to the rolling buffer so the client still gets *something*
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: local }));
    }
    return;
  }

  // Flight plan proxy: GET /flightplan/:flightId
  const fpMatch = req.url.match(/^\/flightplan\/([^/?]+)/);
  if (fpMatch) {
    const flightId = decodeURIComponent(fpMatch[1]);
    if (!isValidId(flightId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid flight id' }));
      return;
    }
    const cached = cache[flightId];
    if (!cached || !cached.sessionId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'flight not in cache' }));
      return;
    }
    try {
      const data = await apiGet(`/sessions/${cached.sessionId}/flights/${flightId}/flightplan`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ───────────────────────────────────────────────────────────
//  maxPayload caps inbound frame size so a client can't send huge buffers.
//  The proxy never needs to read client messages (it only pushes), so any
//  inbound data is ignored, and oversized frames are rejected by ws itself.
const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);

  // Per-IP concurrent-connection cap — stops a single host from opening
  // thousands of sockets to exhaust memory.
  const openForIp = wsCountByIp.get(ip) || 0;
  if (openForIp >= WS_MAX_PER_IP) {
    try { ws.close(1013, 'too many connections'); } catch {}
    return;
  }
  wsCountByIp.set(ip, openForIp + 1);

  clients.add(ws);
  console.log(`[ws] client connected  (${clients.size} total)`);

  // Immediate snapshot of current cache
  ws.send(JSON.stringify({
    type:    'snapshot',
    flights: Object.values(cache),
    ts:      Date.now(),
  }));

  // If polling was paused (no clients) the cache is stale — refresh now so
  // this client doesn't sit on old data until the next interval tick.
  if (Date.now() - lastPollTs > POLL_BASE) poll();

  // This server is push-only — ignore anything the client sends.
  ws.on('message', () => { /* intentionally ignored */ });

  const cleanup = () => {
    clients.delete(ws);
    const c = (wsCountByIp.get(ip) || 1) - 1;
    if (c <= 0) wsCountByIp.delete(ip); else wsCountByIp.set(ip, c);
  };
  ws.on('close', () => { cleanup(); console.log(`[ws] client left  (${clients.size} remaining)`); });
  ws.on('error', cleanup);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Polaris proxy listening on :${PORT}`);
  refreshMeta();
  setInterval(refreshMeta, 6 * 60 * 60 * 1000);  // refresh every 6 h
  poll();
  setInterval(() => poll(), POLL_BASE + Math.random() * 2000);
});
