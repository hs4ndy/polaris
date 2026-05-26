'use strict';

const http  = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');

const PORT       = process.env.PORT     || 3001;
const API_KEY    = process.env.IF_API_KEY || '';
const API_HOST   = 'api.infiniteflight.com';
const POLL_BASE  = 15000;

// In-memory cache: flightId (string) → enriched flight object
const cache         = {};
const clients       = new Set();
let   aircraftNames = {};   // aircraftId (GUID) → human-readable name, e.g. "A320"

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

// ── Aircraft name lookup (fetched once at boot, refreshed every 6 h) ──────────
//  The IF Live API exposes aircraft metadata in two places:
//    1) GET /aircraft        → top-level list of aircraft types
//    2) GET /liveries        → liveries, each carries aircraftID + aircraftName
//  Field naming varies (aircraftId vs aircraftID, id vs aircraftID). We try
//  /aircraft first, and if it doesn't yield a usable map, fall back to /liveries.
async function refreshAircraftNames() {
  if (!API_KEY) return;
  const before = Object.keys(aircraftNames).length;

  // Attempt 1: /aircraft
  try {
    const res  = await apiGet('/aircraft');
    const list = Array.isArray(res?.result) ? res.result : [];
    for (const a of list) {
      const id   = a.id || a.aircraftID || a.aircraftId;
      const name = a.name || a.aircraftName || a.aircraft;
      if (id && name) aircraftNames[id] = name;
    }
    if (list.length) {
      console.log(`[aircraft] /aircraft returned ${list.length} entries (${Object.keys(aircraftNames).length - before} added)`);
    } else {
      console.warn('[aircraft] /aircraft returned 0 entries');
    }
  } catch (e) {
    console.warn('[aircraft] /aircraft failed:', e.message);
  }

  // Attempt 2: /liveries — used to backfill if /aircraft was empty/missing
  if (Object.keys(aircraftNames).length === 0) {
    try {
      const res  = await apiGet('/liveries');
      const list = Array.isArray(res?.result) ? res.result : [];
      const seen = new Set();
      for (const l of list) {
        const id   = l.aircraftID || l.aircraftId || l.id;
        const name = l.aircraftName || l.aircraft || l.name;
        if (id && name && !seen.has(id)) {
          aircraftNames[id] = name;
          seen.add(id);
        }
      }
      console.log(`[aircraft] /liveries fallback loaded ${seen.size} unique aircraft from ${list.length} liveries`);
    } catch (e) {
      console.error('[aircraft] /liveries fallback failed:', e.message);
    }
  }

  console.log(`[aircraft] total names in cache: ${Object.keys(aircraftNames).length}`);
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
            aircraftId:          acId,                  // pass through for debugging
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

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
    const flightId = pathMatch[1];
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
    const flightId = fpMatch[1];
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
  refreshAircraftNames();
  setInterval(refreshAircraftNames, 6 * 60 * 60 * 1000);  // refresh every 6 h
  poll();
  setInterval(() => poll(), POLL_BASE + Math.random() * 2000);
});
