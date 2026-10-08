# Polaris handoff

Verified against local source, Git history and tests on **2026-10-07**. This is the current-state reference; earlier conversation summaries and the design playbook can be stale.

## Project and working rules

- Independent live tracker for the **Infinite Flight simulator**, not real-world aviation.
- Workspace: `C:\Users\harri\OneDrive\Desktop\polaris-if tracker`; PowerShell; Node 24 available.
- Repository: `https://github.com/hs4ndy/polaris.git`, branch `master`.
- User wants professional personal-agent communication, “sir,” candid uncertainty, and no invented facts.
- **Standing instruction: push completed changes automatically.** Use commit identity `Codex <codex@openai.com>`. Preserve unrelated user changes and stage explicit files.
- `polaris-design-playbook.md` is user-owned, untracked, and intentionally excluded from these commits. It describes the old single-file `index.html` tracker; the tracker is now `tracker.html`.

## Architecture and deployment

- Static vanilla HTML/CSS/JS frontend on Vercel; no React or frontend build required.
- Landing: `index.html` → `https://polaris-liart-rho.vercel.app/`.
- Tracker: `tracker.html` → `/tracker`. Legal drafts: `/privacy`, `/terms`, `/cookies`, shared `legal.css`.
- `vercel.json` has explicit page rewrites before a fallback to `tracker.html`; listed asset extensions bypass the fallback. Unknown extensionless routes currently show the tracker, **not a real 404**.
- `server.js` is a separate Node HTTP/WebSocket proxy on Render: `https://polaris-proxy-u3fw.onrender.com` (WebSocket uses `wss://`). Install dependencies with `npm install`; `npm start` runs the proxy.
- Environment names: `IF_API_KEY`, optional `IF_API_HOST`, `PORT`, `ALLOWED_ORIGINS`. Never print or commit credentials. `.env*`, `node_modules`, `.scratch`, `.claude`, logs are ignored.
- Proxy polls roughly every 15–17 seconds, fans out cached flights, and stops upstream polling when no WebSocket clients remain. Browser closes its socket after **10 minutes of inactivity** and displays a Resume card.
- Local tracker switches to localhost proxy only when hostname is exactly `localhost`; `127.0.0.1` uses production. Do not mistake a missing local proxy for a production bug.
- **Deployment caveat:** during this session, Git pushes to `master` created Preview deployments, not Production. Production was released through the signed-in Vercel dashboard: deployment inspector → Deployment Actions → Promote to Production → confirm → wait for Ready. Connected deployment-read tools worked; promotion API failed with team-scope authorization. Do not repeatedly retry that known failure or assume a Git push alone updated production.
- Vercel project `polaris`: `prj_bEfmz019nOAWyLDaPoIXvKcz8glO`; team `hs4ndys-projects`, `team_z3eUdVXp7fpp7evupgGDKGVS`.

## Completed in this session

| Commit | Delivered |
| --- | --- |
| `3ac1143`, `d6c4746` | Self-hosted landing without Lovable branding; landing became static root index and original tracker moved to `/tracker`. |
| `4c5c03a` | Improved geographic LAX→DFW illustration, simpler three-step copy, footer links and explicitly draft legal pages. |
| `27588ad`, `89f56ff` | Selected-flight endpoint markers, globe alignment, recorded-trail start anchoring and named destination lookup. |
| `1e13c64` | Explicit ICAO aircraft codes across list/detail chips; final black-center/blue-ring endpoint appearance. |
| `5005cef` | User's PolarisStar PNG copied unchanged to `favicon.png` and linked on all five public pages. |

Last application commit before this handoff: **`5005cef`**, matching local `origin/master`. At release, Vercel Production was Ready and favicon plus all five pages returned HTTP 200 with correct favicon links. Production deployment: `dpl_HGdADa9CAdC5NHbgP24eVYuCzxXS`. This handoff does not claim a fresh live-flight or production-console audit on October 7.

## Design and feature decisions

- Black space/background, near-black seas, one blue accent (`#4f8ef7`) for all servers and paths; liquid-glass panels. No gradients, glowing buttons, or hover motion except flight-list/sidebar interactions. Search placeholder is simply “Search.”
- MapLibre GL JS v5 globe projection replaces the original Globe.gl/Three.js implementation. Zoomed-in view gives detailed map tiles. Preserve current `plane.svg` aircraft silhouette and heading behavior.
- Detail panel width 392px; Aircraft → Flight Data → Graph → Waypoints. Labels brightened, spacing equalized; redundant server row and overlapping chart corner labels removed. Missing username displays `Guest`; speed is knots, route distances display `nm`.
- Selected flight only: solid line is recorded history; dotted line is a **direct great-circle from current aircraft position to destination**, not the filed intermediate route. Do not rewrite the solid trail when changing future-route behavior.
- Without a usable plan, a four-minute heading projection can appear; it is not a known destination. Plan/path loaders retry at 2/5/10 seconds and retry missing data every minute while active.
- Final endpoint layer `route-endpoint-dots`: radius 4, opaque `#000000` center, 1.3px blue stroke, `circle-pitch-alignment` and `circle-pitch-scale` both `map`, above paths/below aircraft. `ENDPOINT_COLOR` independently controls ring color. No color-picker UI was added.
- `routeEndpointsFC`: start is first recorded trail sample when at least two samples exist; otherwise named departure or plan edge. Finish prefers named destination, then plan edge. Invalid coordinates are omitted. Markers clear on deselection; clicking empty map also deselects.
- `aircraft-codes.js` exposes `aircraftChip` globally and via CommonJS for tests. Explicit normalized aliases replace guessed number extraction. All **61 names** returned by live `/meta/liveries` were covered and mapped codes existed in official ICAO data at implementation time. Unknown types hide their chip instead of inventing a code.
- Official codes supersede earlier custom labels: 737-700/BBJ=`B737`, -800=`B738`, -900=`B739`, MAX8=`B38M`; A321neo=`A21N` (not A321NX); E175=`E75L`, confirmed by Infinite Flight's model page.
- Source references: `https://infiniteflight.com/fleet`, `https://infiniteflight.com/fleet/e175`, `https://www.icao.int/operational-safety/doc-8643-aircraft-type-designators/search`. ICAO search loads official data from POST `https://doc8643.icao.int/External/AircraftTypes`.

## Data, artwork and earlier lessons

- `photos.json` plus bundled `photos/` matches aircraft/livery information, not callsign guesses. Photo manifest completion repaints a quickly selected aircraft. Credits: Jan Polet / helpathand.nl; obtain commercial-use permission before monetization. Existing photos are not proof of a perpetual complete fleet catalog.
- `airports.json` maps ICAO→IATA: e.g. MMUN→CUN, KDFW→DFW. Never strip the first character as a global conversion rule.
- Route query supports `DFW-BZN`, ICAO/IATA, and one-sided forms. Route search ignores active server tab. Low enrichment coverage shows Loading; empty state says “No active flights for…” and “Make sure the route is filed or typed in correctly (e.g. JFK-LAX).”
- Server enrichment: bulk plans POST body is `{ flightIds: [...] }`, 10 IDs/call, up to 25 calls/poll, 30-minute TTL. **Null entries for planless flights must be skipped** or entire batches fail. Coverage is incremental, not instant.
- Flight-plan item `type` is not a reliable origin/destination flag. Resolve airport names from flat `waypoints`; descend procedure children and reject invalid/null-island coordinates.
- `landing-route.svg` is static **illustrative, not live data**. `tools/build-landing-route.cjs` regenerates it using public-domain Natural Earth geography, real LAX/DFW coordinates and the existing plane silhouette. Cards: choose server; search/map; “Select it to watch the flight data.”
- Original failures: removed Globe.gl `ringStroke` API broke initialization; Three.js legacy minified CDN URL returned 404; DOM plane overlays lagged/floated; 3D models looked wrong. Do not resurrect that rendering stack for a cosmetic change.

## Known limitations and launch work

1. **Destination mismatch risk:** endpoint marker resolves named airport, but `updateTrails()` dotted line and some route calculations still use the last flattened waypoint. An appended approach fix may differ. Align these consumers in a future scoped fix; not changed by this documentation task.
2. “Start” means first **available** recorded sample, not necessarily actual takeoff. Truncated history/live fallback cannot establish an exact historical departure; avoid claiming otherwise.
3. Legal pages are visible drafts dated October 4 and `noindex`. Public operator/contact channel, legal basis, provider-log retention, third-party cookie audit and applicable legal review remain pending. No contact email supplied; do not expose a personal email or invent one. No cosmetic cookie banner added; future nonessential tracking needs appropriate consent where applicable.
4. Source has basic protections (100 HTTP requests/IP/min, 8 concurrent sockets/IP, 4KB WebSocket payload limit, 256-character request-target cap, GET/HEAD allow-list, input checks). This is **not a completed full security audit**. CORS defaults to `*` without configured origins; no WS origin allow-list seen. Review trusted proxy/IP handling, Git-history secrets, dependencies, exposed deployment files and frontend security headers before launch.
5. No accounts, payments or analytics integration implemented. Autopilot Plus tracking was requested historically but capability is **not verified/implemented in this session**; investigate IF API documentation before promising it. Monetization ideas (ATC, profiles, replay, alerts) are unimplemented.
6. Domain `polarisif.app` was liked but purchase/connection deferred. Launch SEO/404/performance checks still outstanding; latest favicon is the original non-square ~1.16MB PNG, not an optimized multi-size icon set.
7. Automated tests are focused unit/static checks, not complete browser/WebGL, backend security or live-route regression coverage. Full selected-flight behavior after the final code/ring changes was not visually audited in this session.

## Verification and next session

Run `node --test tests/*.test.cjs` (15 tests passed on October 7), `git diff --check`, and inspect `git status` before editing. Test files cover landing routes/copy/artwork/legal links, aircraft aliases, endpoint coordinates/style/cleanup and shared PNG favicon. Use `node tools/build-landing-route.cjs` only when intentionally regenerating the landing artwork (requires network).

Next: follow the user's next scoped request; otherwise prioritize a browser regression of selected flights (path/dot endpoints, map tilt, route search, photos, chart, idle resume), resolve destination-consumer mismatch, then finish legal/contact/licensing and launch security/SEO checks. Commit as Codex, push explicit task files, and verify Production Ready when releasing runtime changes. A documentation-only handoff does not require manually promoting a new production build.
