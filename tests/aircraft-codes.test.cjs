const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aircraftChip, groups } = require('../aircraft-codes.js');

test('all explicitly supported models and aliases resolve to their designator', () => {
  for (const [code, ...aliases] of groups) {
    for (const name of [code, ...aliases]) assert.equal(aircraftChip(name), code, name);
  }
});

test('manufacturer prefixes and punctuation differences are normalized', () => {
  const cases = {
    'Boeing 737-700-BBJ': 'B737', 'Boeing 737-800': 'B738', 'Boeing 737-900': 'B739',
    'Boeing 737-8 MAX': 'B38M', 'Airbus A321 NEO': 'A21N', 'Airbus A350-1000': 'A35K',
    'Bombardier Dash 8-Q400': 'DH8D', 'Bombardier Challenger 350': 'CL35',
    'Embraer E175': 'E75L', 'Lockheed C-130J-30': 'C30J', 'McDonnell Douglas MD-11F': 'MD11',
    'Fairchild Republic A-10': 'A10', 'Piper PA-28 Archer': 'P28A', 'CubCrafters XCub': 'CC19',
    'Boeing F/A-18E Super Hornet': 'F18S', 'Cirrus SR22 GTS': 'SR22',
    'Cessna 208 Caravan': 'C208', 'Daher TBM-930': 'TBM9',
  };
  for (const [name, code] of Object.entries(cases)) assert.equal(aircraftChip(name), code, name);
});

test('do not infer an official designator from missing or unknown aircraft names', () => {
  for (const name of ['', null, undefined, 'Boeing 777', 'Airbus A350', 'Future Plane 123']) {
    assert.equal(aircraftChip(name), '');
  }
});
