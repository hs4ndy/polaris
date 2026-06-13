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
let   liveryPairs   = [];   // [{aircraft, livery}] — full catalog for tooling/matching

// Departure/destination ICAO per flight, for route search ("DFW-BZN"). Built
// incrementally from the bulk flight-plans endpoint (POST, max 10 IDs/call) a
// few batches per poll so we never hammer the IF API. Plans rarely change, so
// once cached an entry is reused for a long time.
//   planMeta[flightId] = { dep, dest, ts }
const planMeta            = {};
const PLAN_TTL_MS         = 30 * 60 * 1000;   // re-fetch a flight's plan at most every 30 min
const PLAN_IDS_PER_CALL   = 10;               // IF API hard cap per bulk request
// ≤ 250 flights enriched per poll. Cold start covers a few-thousand-flight
// world in ~2-3 min, then drops to near-zero (only new flights / TTL refreshes)
// since enrichPlans only queries flights missing fresh dep/dest. Calls are
// sequential, so a full batch is ~6-8s — well inside the 15s poll interval.
const PLAN_CALLS_PER_POLL = 25;

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

// ── HTTP POST helper (JSON body) ────────────────────────────────────────────────
function apiPost(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const body     = JSON.stringify(bodyObj);
    const fullPath = `/public/v2${path}${path.includes('?') ? '&' : '?'}apikey=${API_KEY}`;
    const req = https.request(
      {
        hostname: API_HOST, path: fullPath, method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept:           'application/json',
        },
      },
      res => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch { reject(new Error('JSON parse failed')); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('request timeout')); });
    req.write(body);
    req.end();
  });
}

// Extract departure/destination ICAO from a flight plan. First/last 4-letter
// ICAO codes in the route are the filed origin and destination. Prefer the flat
// `waypoints` string array; fall back to names in flightPlanItems.
function extractDepDest(plan) {
  let icaos = (Array.isArray(plan?.waypoints) ? plan.waypoints : [])
    .map(n => String(n || '').trim().toUpperCase())
    .filter(n => /^[A-Z]{4}$/.test(n));

  if (!icaos.length && Array.isArray(plan?.flightPlanItems)) {
    const names = [];
    (function walk(items) {
      for (const it of items || []) {
        if (it && it.name) names.push(String(it.name).trim().toUpperCase());
        if (it && Array.isArray(it.children)) walk(it.children);
      }
    })(plan.flightPlanItems);
    icaos = names.filter(n => /^[A-Z]{4}$/.test(n));
  }

  if (!icaos.length) return { dep: '', dest: '' };
  return { dep: icaos[0], dest: icaos[icaos.length - 1] };
}

// Incrementally fill planMeta for flights that lack a fresh dep/dest, a few
// bulk calls per invocation. `updated` is { flightId → flight } from this poll.
async function enrichPlans(updated) {
  if (!API_KEY) return;
  const now = Date.now();

  // Group flights still needing plan data by their session
  const bySession = {};
  for (const [id, f] of Object.entries(updated)) {
    const m = planMeta[id];
    if (m && now - m.ts < PLAN_TTL_MS) continue;
    if (!f.sessionId) continue;
    (bySession[f.sessionId] = bySession[f.sessionId] || []).push(id);
  }

  let calls = 0;
  outer:
  for (const [sid, ids] of Object.entries(bySession)) {
    for (let i = 0; i < ids.length; i += PLAN_IDS_PER_CALL) {
      if (calls >= PLAN_CALLS_PER_POLL) break outer;
      const chunk = ids.slice(i, i + PLAN_IDS_PER_CALL);
      calls++;
      try {
        // IF expects an object with a flightIds array — NOT a bare array
        const res   = await apiPost(`/sessions/${sid}/flights/flightplans`, { flightIds: chunk });
        const plans = Array.isArray(res?.result) ? res.result : [];
        for (const p of plans) {
          const { dep, dest } = extractDepDest(p);
          planMeta[String(p.flightId)] = { dep, dest, ts: now };
        }
        // Mark requested-but-not-returned IDs as attempted so we don't retry
        // them every single poll (no filed plan → empty dep/dest, TTL applies)
        for (const id of chunk) if (!planMeta[id]) planMeta[id] = { dep: '', dest: '', ts: now };
      } catch (e) {
        // Transient failure — leave them uncached so a later poll retries
      }
    }
  }

  // Drop meta for flights that have left the world
  for (const id of Object.keys(planMeta)) if (!updated[id]) delete planMeta[id];
}

// ── Aircraft + livery metadata (fetched at boot, refreshed every 6 h) ─────────
//  GET /aircraft/liveries returns one row per livery, each carrying BOTH the
//  aircraft type (aircraftID + aircraftName) and the livery (id + liveryName,
//  usually the airline, e.g. "American Airlines"). One call populates both
//  maps. /aircraft is a fallback only if the liveries call fails to give types.
//  NOTE: the path is /aircraft/liveries — NOT /liveries. Using the wrong path
//  silently 404'd, leaving liveryNames empty so no flight ever showed an
//  airline, while the /aircraft fallback still filled aircraft types.
async function refreshMeta() {
  if (!API_KEY) return;

  try {
    const res  = await apiGet('/aircraft/liveries');
    const list = Array.isArray(res?.result) ? res.result : [];
    const pairs = [];
    for (const l of list) {
      const acId = l.aircraftID || l.aircraftId;
      const acNm = l.aircraftName || l.aircraft;
      const lvId = l.id || l.liveryID || l.liveryId;
      const lvNm = l.liveryName || l.livery || l.name;
      if (acId && acNm) aircraftNames[acId] = acNm;
      if (lvId && lvNm) liveryNames[lvId]   = lvNm;
      if (acNm && lvNm) pairs.push({ aircraft: acNm, livery: lvNm });
    }
    if (pairs.length) liveryPairs = pairs;
    console.log(`[meta] /aircraft/liveries: ${list.length} rows → ${Object.keys(aircraftNames).length} aircraft, ${Object.keys(liveryNames).length} liveries`);
  } catch (e) {
    console.error('[meta] /aircraft/liveries failed:', e.message);
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
          const pm   = planMeta[id];                    // dep/dest filled in by enrichPlans
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
            dep:                 pm?.dep  || '',         // departure ICAO (route search)
            dest:                pm?.dest || '',         // destination ICAO (route search)
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

    // Enrich a few flights' dep/dest after broadcasting (doesn't delay the
    // position update). The values land on the next poll's broadcast.
    await enrichPlans(updated);
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

  // Livery catalog: GET /meta/liveries
  // Full {aircraft, livery} pair list straight from the in-memory metadata —
  // no upstream call, cheap to serve. Used by tooling (photo matcher) and
  // available for future client features (filters, search).
  if (req.url.startsWith('/meta/liveries')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify({ result: liveryPairs }));
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
