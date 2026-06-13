'use strict';

// build-airports.js — generates airports.json (ICAO → IATA) from the
// OurAirports public-domain dataset (.scratch/airports.csv).
//
//   node tools/build-airports.js
//
// OurAirports is released into the public domain (ourairports.com/data),
// so no attribution or licensing is required to bundle this map.

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSV  = path.join(ROOT, '.scratch', 'airports.csv');
const OUT  = path.join(ROOT, 'airports.json');

// Minimal RFC-4180-ish line parser (handles quoted fields with commas/quotes)
function parseLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const text  = fs.readFileSync(CSV, 'utf8');
const lines = text.split(/\r?\n/).filter(Boolean);
const header = parseLine(lines[0]);
const col = name => header.indexOf(name);
const iIdent = col('ident');
const iIcao  = col('icao_code');
const iIata  = col('iata_code');

const map = {};
let rows = 0;
for (let i = 1; i < lines.length; i++) {
  const f = parseLine(lines[i]);
  const iata = (f[iIata] || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(iata)) continue;            // only real 3-letter IATA codes
  // Prefer the explicit icao_code column; fall back to ident when it looks ICAO
  let icao = (f[iIcao] || '').trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(icao)) {
    const id = (f[iIdent] || '').trim().toUpperCase();
    icao = /^[A-Z]{4}$/.test(id) ? id : '';
  }
  if (!icao) continue;
  if (!map[icao]) { map[icao] = iata; rows++; }       // first wins (data is ordered)
}

// Compact single-line JSON keeps the file small (~150 KB)
fs.writeFileSync(OUT, JSON.stringify(map) + '\n');
console.log(`airports.json: ${rows} ICAO→IATA mappings`);

// Spot-checks the user named
for (const k of ['MMUN', 'KDFW', 'EGLL', 'KJFK', 'KBOS', 'RJTT', 'OMDB']) {
  console.log(`  ${k} → ${map[k] || '(none)'}`);
}
