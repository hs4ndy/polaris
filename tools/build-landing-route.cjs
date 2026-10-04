'use strict';

// Generated static artwork, not a live flight. Coastlines: public-domain Natural
// Earth 1:110m. Airport coordinates: OurAirports (KLAX and KDFW).
const fs = require('node:fs');
const path = require('node:path');
const SOURCE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
const LAX = [-118.407997, 33.942501];
const DFW = [-97.038002, 32.896801];
const rad = Math.PI / 180;
const width = 800;
const height = 340;
const scale = width / (33 * rad);
const mercatorY = lat => Math.log(Math.tan(Math.PI / 4 + lat * rad / 2));
function project([lon, lat]) {
  return [(lon + 124) * rad * scale, (mercatorY(40) - mercatorY(lat)) * scale];
}
function interpolate(a, b, t) {
  const vector = ([lon, lat]) => [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)];
  const u = vector(a), v = vector(b);
  const angle = Math.acos(Math.max(-1, Math.min(1, u.reduce((sum, x, i) => sum + x * v[i], 0))));
  const p = u.map((x, i) => (x * Math.sin((1 - t) * angle) + v[i] * Math.sin(t * angle)) / Math.sin(angle));
  return [Math.atan2(p[1], p[0]) / rad, Math.atan2(p[2], Math.hypot(p[0], p[1])) / rad];
}
const pair = point => point.map(n => n.toFixed(2)).join(' ');
const routePath = (start, end) => Array.from({ length: 65 }, (_, i) => `${i ? 'L' : 'M'}${pair(project(interpolate(LAX, DFW, start + (end - start) * i / 64)))}`).join(' ');

async function build() {
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`Natural Earth download failed: ${response.status}`);
  const geo = await response.json();
  const land = geo.features.filter(f => ['USA', 'CAN', 'MEX', 'CUB'].includes(f.properties.ADM0_A3)).map(f => {
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const d = polygons.map(p => p.map(ring => ring.map((point, i) => `${i ? 'L' : 'M'}${pair(project(point))}`).join(' ') + ' Z').join(' ')).join(' ');
    return `<path d="${d}"/>`;
  }).join('\n');
  const start = project(LAX), end = project(DFW), current = project(interpolate(LAX, DFW, .46));
  const next = project(interpolate(LAX, DFW, .461));
  const heading = Math.atan2(next[1] - current[1], next[0] - current[0]) / rad + 90;
  const plane = fs.readFileSync(path.join(__dirname, '..', 'plane.svg'), 'utf8').match(/\sd="([^"]+)"/)[1];
  const grid = [-120, -110, -100, -90, -80].map(lon => `<path d="M${pair(project([lon, 51]))} L${pair(project([lon, 26]))}"/>`).join('') + [30, 40, 50].map(lat => `<path d="M${pair(project([-127, lat]))} L${pair(project([-75, lat]))}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">Illustrative flight from Los Angeles to Dallas Fort Worth</title>
<desc id="desc">Airport markers use real coordinates. A blue aircraft follows a great-circle route; the flown segment is solid and the remaining segment dotted. This is not live flight data.</desc>
<defs><clipPath id="map"><rect width="800" height="340" rx="8"/></clipPath></defs>
<g clip-path="url(#map)">
<rect width="800" height="340" fill="#05080c"/>
<g stroke="#15202c" stroke-width=".7" fill="none">${grid}</g>
<g fill="#0c1118" stroke="#26313d" stroke-width="1" fill-rule="evenodd">${land}</g>
<text x="425" y="125" fill="#738194" font-family="monospace" font-size="11" letter-spacing="3">UNITED STATES</text>
<g stroke="#4f8ef7" stroke-width="2.5" stroke-linecap="round" fill="none">
<path d="${routePath(0, .46)}"/><path d="${routePath(.46, 1)}" stroke-dasharray="1 7"/>
<circle cx="${start[0]}" cy="${start[1]}" r="4.5" fill="#05080c"/><circle cx="${end[0]}" cy="${end[1]}" r="4.5" fill="#05080c"/>
</g>
<g transform="translate(${pair(current)}) rotate(${heading.toFixed(2)}) scale(.58) translate(-23.438 -23.438)"><path d="${plane}" fill="#4f8ef7" stroke="#05080c" stroke-width="1.5"/></g>
<g font-family="monospace" fill="#f0f4f8" font-size="26" letter-spacing="1">
<text x="${start[0] - 18}" y="${start[1] + 30}">LAX</text><text x="${end[0] - 18}" y="${end[1] + 30}">DFW</text>
</g></g></svg>\n`;
  fs.writeFileSync(path.join(__dirname, '..', 'landing-route.svg'), svg);
  console.log('Generated landing-route.svg with real airport locations and joined great-circle segments.');
}
if (require.main === module) build().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { project, interpolate, LAX, DFW };
