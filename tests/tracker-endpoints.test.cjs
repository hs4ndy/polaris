const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'tracker.html'), 'utf8');
const source = html.match(/function routeEndpointsFC\(waypoints[^\n]*\{[\s\S]*?\n\}/)[0];
const validator = html.match(/function isValidLatLng\(lat, lng\) \{[\s\S]*?\n\}/)[0];
const endpoints = vm.runInNewContext(`${validator}\n(${source})`);

test('filed endpoints use GeoJSON longitude/latitude and ignore intermediate waypoints', () => {
  const result = endpoints([{ lat: 33.94, lng: -118.4 }, { lat: 35, lng: -110 }, { lat: 32.89, lng: -97.03 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.features.map(f => [f.properties.role, f.geometry.coordinates]))),
    [['departure', [-118.4, 33.94]], ['destination', [-97.03, 32.89]]]);
});

test('missing plans and invalid endpoints do not create misleading markers', () => {
  for (const value of [null, [], [{ lat: 0, lng: 0 }]]) assert.equal(endpoints(value).features.length, 0);
  assert.equal(endpoints([{ lat: NaN, lng: 0 }, { lat: 91, lng: 0 }]).features.length, 0);
  assert.equal(endpoints([{ lat: 33, lng: -118 }, { lat: 0, lng: 181 }]).features.length, 1);
  assert.equal(endpoints([{ lat: 0, lng: 0 }, { lat: 0, lng: 0 }]).features.length, 0);
});

test('endpoint source refreshes with selection and clears with paths', () => {
  assert.match(html, /setData\('route-endpoints', routeEndpointsFC\(flightPlanWPs, endpointTrail, flightPlanDepName, flightPlanDestName\)\)/);
  assert.match(html, /for \(const s of \['trail', 'projection', 'flightplan', 'route-endpoints'\]\)/);
  assert.ok(html.indexOf("id: 'route-endpoint-dots'") > html.indexOf("id: 'projection-line'"));
  assert.ok(html.indexOf("id: 'route-endpoint-dots'") < html.indexOf("id: 'planes-ground'"));
});

test('start matches the recorded trail and finish matches the airport, not appended approach fixes', () => {
  const wps = [{ name: 'SID', lat: 34, lng: -117 }, { name: 'KLAX', lat: 33.94, lng: -118.4 },
    { name: 'KDFW', lat: 32.89, lng: -97.03 }, { name: 'APP', lat: 33, lng: -97 }];
  const trail = [{ lat: 33.95, lng: -118.41 }, { lat: 34, lng: -118 }];
  const points = endpoints(wps, trail, 'KLAX', 'KDFW').features;
  assert.deepEqual(JSON.parse(JSON.stringify(points.map(f => f.geometry.coordinates))), [[-118.41, 33.95], [-97.03, 32.89]]);
  assert.equal(endpoints(wps, [], 'KLAX', 'KDFW').features[0].geometry.coordinates[0], -118.4);
});

test('solid dots are map-aligned, slightly larger and independently recolorable', () => {
  const layer = html.match(/id: 'route-endpoint-dots'[\s\S]*?\n  \}\);/)[0];
  assert.match(layer, /'circle-radius': 4/);
  assert.match(layer, /'circle-color': ENDPOINT_COLOR/);
  assert.match(layer, /'circle-pitch-alignment': 'map'/);
  assert.match(layer, /'circle-pitch-scale': 'map'/);
  assert.doesNotMatch(layer, /circle-stroke/);
});
