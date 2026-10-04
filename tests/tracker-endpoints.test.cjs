const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'tracker.html'), 'utf8');
const source = html.match(/function routeEndpointsFC\(waypoints\) \{[\s\S]*?\n\}/)[0];
const endpoints = vm.runInNewContext(`(${source})`);

test('filed endpoints use GeoJSON longitude/latitude and ignore intermediate waypoints', () => {
  const result = endpoints([{ lat: 33.94, lng: -118.4 }, { lat: 35, lng: -110 }, { lat: 32.89, lng: -97.03 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.features.map(f => [f.properties.role, f.geometry.coordinates]))),
    [['departure', [-118.4, 33.94]], ['destination', [-97.03, 32.89]]]);
});

test('missing plans and invalid endpoints do not create misleading markers', () => {
  for (const value of [null, [], [{ lat: 0, lng: 0 }]]) assert.equal(endpoints(value).features.length, 0);
  assert.equal(endpoints([{ lat: NaN, lng: 0 }, { lat: 91, lng: 0 }]).features.length, 0);
  assert.equal(endpoints([{ lat: 0, lng: 0 }, { lat: 0, lng: 181 }]).features.length, 1);
});

test('endpoint source refreshes with selection and clears with paths', () => {
  assert.match(html, /setData\('route-endpoints', routeEndpointsFC\(flightPlanWPs\)\)/);
  assert.match(html, /for \(const s of \['trail', 'projection', 'flightplan', 'route-endpoints'\]\)/);
  assert.ok(html.indexOf("id: 'route-endpoint-dots'") > html.indexOf("id: 'projection-line'"));
  assert.ok(html.indexOf("id: 'route-endpoint-dots'") < html.indexOf("id: 'planes-ground'"));
});
