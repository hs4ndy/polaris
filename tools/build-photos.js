'use strict';

// build-photos.js — one-shot tool that builds the aircraft-photo library.
//
//   node tools/build-photos.js --refresh [--dry]
//
// 1. Parses the live Jan Polet catalog with --refresh, or the saved copy at
//    .scratch/liveries.html without it, into rows
//    {aircraft, operator, variant, imageUrl}.
// 2. Fetches the official IF livery catalog from our proxy (/meta/liveries)
//    so manifest keys exactly match what the Live API calls each livery.
// 3. Fuzzy-matches site rows to API pairs and adds only missing thumbnails
//    and keys. Existing images and photos.json entries are preserved.
//
// All photos are credited to Jan Polet — helpathand.nl. Ask permission before
// shipping publicly; see the IFC thread "Database with all aircraft liveries".

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const HTML_PATH  = path.join(ROOT, '.scratch', 'liveries.html');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const MANIFEST   = path.join(ROOT, 'photos.json');
const PROXY      = 'https://polaris-proxy-u3fw.onrender.com';
const SOURCE     = 'https://www.helpathand.nl/janpolet/infinite-flight-aircraft-liveries/';
const CREDIT     = 'Jan Polet — helpathand.nl';
const DRY        = process.argv.includes('--dry');
const REFRESH    = process.argv.includes('--refresh');

// ── Parse the TablePress rows ───────────────────────────────────────────────
function parseSiteRows(html) {
  const rows = [];
  // Each data row: <tr class="row-N"> ... columns 2,3,4,5 and the col-9 img
  const trRe = /<tr class="row-\d+">([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html))) {
    const tr = m[1];
    const col = n => {
      const c = tr.match(new RegExp(`<td class="column-${n}">([\\s\\S]*?)<\\/td>`));
      if (!c) return '';
      return c[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim();
    };
    const img = tr.match(/<img[^>]+src="([^"]+)"/);
    if (!img) continue;
    const manufacturer = col(2);
    const type         = col(3);
    if (!manufacturer || !type) continue;
    rows.push({
      aircraft: `${manufacturer} ${type}`,
      operator: col(4),
      variant:  col(5),
      imageUrl: img[1],
    });
  }
  return rows;
}

// ── Normalization + matching ────────────────────────────────────────────────
// Accent folding first ("Aéreos" → "Aereos") — the API uses accents, the site
// mostly doesn't, and plain stripping deleted the accented letter entirely.
const norm = s => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

// Noise words that differ between IF names and the site's labels. Stripped at
// WORD level before squashing — substring stripping mangled names ("the"
// inside "…west Heart" → "southwesart") and silently broke tier-3 matches.
// "and" bridges "Red & White" ↔ "Red and White".
const NOISE = /\b(airlines|airways|airline|virtual|the|aircraft|and)\b/gi;
const stripNoise = s => norm(String(s || '').replace(NOISE, ' '));

// Aircraft families the site labels differently than the API
const AC_ALIASES = {
  e175: 'embraer175',   // API "E175" → site "Embraer | 175"
  e190: 'embraer190',
};

// Stubborn livery-name differences (incl. two typos on the site itself)
const LIVERY_ALIASES = {
  'HOP!':                      'Air France Hop',
  'SA Express':                'South African Express',
  'Jet2':                      'Jet2.com',
  'Jet2 holidays':             'Jet2.com',
  'French Army':               'French Air Force',
  'American Airlines - Old':   'American Airlines 1968',
  'JetBlue - Blueprint':       'JetBlue Bleuprint',       // site typo
  'BBJ - Gold and Red':        'BBJ Glod and Red',        // site typo
  'BBJ3':                      'BBJ',
  'Iberia - New Air Nostrum':  'Air Nostrum New',
  'Iberia - Retro Air Nostrum':'Air Nostrum Retro',
  'TUI':                       'TUIfly',
};

// The API abbreviates "United States" to "US"; the site doesn't.
const expandUS = s => String(s || '').replace(/^US /, 'United States ');

function buildMatcher(siteRows) {
  // Group site rows by noise-stripped aircraft name ("Cirrus Aircraft SR22"
  // → "cirrussr22") for candidate lookup
  const byAircraft = new Map();
  for (const r of siteRows) {
    const key = stripNoise(r.aircraft);
    if (!byAircraft.has(key)) byAircraft.set(key, []);
    byAircraft.get(key).push(r);
  }
  const aircraftKeys = [...byAircraft.keys()];

  function aircraftCandidates(apiAircraft) {
    let acKey = stripNoise(apiAircraft);
    acKey = AC_ALIASES[acKey] || acKey;
    let c = byAircraft.get(acKey);
    if (c) return c;
    // The API omits manufacturers ("DC-10" vs "McDonnell Douglas DC-10").
    // Prefer keys that END with the API name (avoids DC-10 ↔ DC-10F mixups);
    // among several, take the shortest (closest fit).
    const ends = aircraftKeys.filter(k => k.endsWith(acKey)).sort((a, b) => a.length - b.length);
    if (ends.length) return byAircraft.get(ends[0]);
    // Last resort: unambiguous containment either direction
    const close = aircraftKeys.filter(k => k.includes(acKey) || acKey.includes(k));
    if (close.length === 1) return byAircraft.get(close[0]);
    return null;
  }

  function attempt(candidates, apiLivery) {
    const lvN = norm(apiLivery);
    const lvS = stripNoise(apiLivery);

    // tier 1: operator+variant exact
    let hit = candidates.find(r => norm(`${r.operator} ${r.variant}`) === lvN);
    if (hit) return { row: hit, tier: 1 };
    // tier 2: operator exact
    hit = candidates.find(r => norm(r.operator) === lvN);
    if (hit) return { row: hit, tier: 2 };
    // tier 3: noise-stripped equality on operator(+variant)
    hit = candidates.find(r =>
      stripNoise(`${r.operator} ${r.variant}`) === lvS || stripNoise(r.operator) === lvS);
    if (hit) return { row: hit, tier: 3 };
    // tier 4: containment either direction (length guard against junk hits)
    if (lvS.length >= 4) {
      hit = candidates.find(r => {
        const o = stripNoise(`${r.operator} ${r.variant}`);
        return o.length >= 4 && (o.includes(lvS) || lvS.includes(o));
      });
      if (hit) return { row: hit, tier: 4 };
    }
    return null;
  }

  return function match(apiAircraft, apiLiveryRaw) {
    const candidates = aircraftCandidates(apiAircraft);
    if (!candidates) return null;

    // The site is inconsistent ("US Navy" raw on some rows, "United States
    // Coast Guard" expanded on others), so try each spelling in turn.
    const variants = [apiLiveryRaw, expandUS(apiLiveryRaw)];
    if (LIVERY_ALIASES[apiLiveryRaw]) variants.push(LIVERY_ALIASES[apiLiveryRaw]);
    for (const v of [...new Set(variants)]) {
      const hit = attempt(candidates, v);
      if (hit) return hit;
    }
    return null;
  };
}

// ── Download helper (sequential, polite, with retries) ─────────────────────
//  The host drops reused keep-alive sockets under sustained load (undici
//  surfaces that as a generic "fetch failed"), so force Connection: close and
//  retry with backoff before giving up.
async function download(url, dest) {
  const source = new URL(url);
  if (source.protocol !== 'https:' ||
      !['www.helpathand.nl', 'helpathand.nl'].includes(source.hostname) ||
      !/^\/janpolet\/wp-content\/uploads\/.*\.png$/i.test(source.pathname)) {
    throw new Error(`unexpected image URL: ${url}`);
  }
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (PolarisPhotoBuilder)',
          'Connection': 'close',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000 || !buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        throw new Error('response is not a PNG image');
      }
      fs.writeFileSync(dest, buf);
      return buf.length;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

const slugify = s => String(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const html = REFRESH
    ? await (async () => {
        const res = await fetch(SOURCE);
        if (!res.ok) throw new Error(`source page HTTP ${res.status}`);
        return res.text();
      })()
    : fs.readFileSync(HTML_PATH, 'utf8');
  const siteRows = parseSiteRows(html);
  console.log(`site rows parsed: ${siteRows.length}`);
  if (siteRows.length < 1000) throw new Error('source catalog is incomplete — aborting');

  const metaRes = await fetch(`${PROXY}/meta/liveries`);
  if (!metaRes.ok) throw new Error(`/meta/liveries HTTP ${metaRes.status} — is the proxy deployed?`);
  const pairs = (await metaRes.json()).result || [];
  console.log(`API livery pairs: ${pairs.length}`);
  if (!pairs.length) throw new Error('API returned 0 pairs — aborting');

  const matchFn  = buildMatcher(siteRows);
  const manifest = fs.existsSync(MANIFEST)
    ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
  const stats    = { matched: 0, existing: 0, byTier: {1:0,2:0,3:0,4:0}, unmatched: [] };
  const jobs     = [];
  const usedFiles = new Set(Object.values(manifest).map(v => v.file));

  for (const p of pairs) {
    const key = `${p.livery}|${p.aircraft}`;
    if (manifest[key]) { stats.existing++; continue; }
    const hit = matchFn(p.aircraft, p.livery);
    if (!hit) { stats.unmatched.push(key); continue; }
    stats.matched++; stats.byTier[hit.tier]++;

    let file = `${slugify(p.aircraft)}--${slugify(p.livery)}.png`;
    let n = 2;
    while (usedFiles.has(file)) file = `${slugify(p.aircraft)}--${slugify(p.livery)}-${n++}.png`;
    usedFiles.add(file);

    manifest[key] = { file, credit: CREDIT };
    jobs.push({ url: hit.row.imageUrl, file });
  }

  console.log(`new matches ${stats.matched}, already mapped ${stats.existing}/${pairs.length} (tiers: ${JSON.stringify(stats.byTier)})`);
  console.log(`unmatched: ${stats.unmatched.length}`);
  if (stats.unmatched.length && !DRY) {
    fs.writeFileSync(path.join(ROOT, '.scratch', 'unmatched.json'), JSON.stringify(stats.unmatched, null, 2));
    console.log('  → list written to .scratch/unmatched.json');
  }

  if (DRY) { console.log('--dry: no files changed'); return; }

  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  let done = 0, bytes = 0, failed = 0;
  for (const j of jobs) {
    const dest = path.join(PHOTOS_DIR, j.file);
    try {
      if (!fs.existsSync(dest)) {           // resumable: skip already-downloaded
        bytes += await download(j.url, dest);
        await new Promise(r => setTimeout(r, 300));  // politeness delay (host throttles faster rates)
      }
    } catch (e) {
      failed++;
      // drop manifest entry for failed download
      for (const [k, v] of Object.entries(manifest)) if (v.file === j.file) delete manifest[k];
      console.warn(`FAIL ${j.file}: ${e.message}`);
    }
    if (++done % 100 === 0) console.log(`  ${done}/${jobs.length} (${(bytes/1048576).toFixed(1)} MB)`);
  }

  if (done - failed) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`DONE: ${done - failed} photos, ${failed} failed, ${(bytes/1048576).toFixed(1)} MB downloaded`);
  console.log(`manifest entries: ${Object.keys(manifest).length} → photos.json`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
