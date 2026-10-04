const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

test('landing and tracker have distinct routes, ahead of the existing fallback', () => {
  assert.deepEqual(config.rewrites[0], { source: '/', destination: '/index.html' });
  assert.deepEqual(config.rewrites[1], { source: '/tracker', destination: '/tracker.html' });
  assert.ok(fs.existsSync(path.join(root, 'tracker.html')));
});

test('both tracker calls to action point to the local tracker route', () => {
  assert.equal((html.match(/href="\/tracker"/g) || []).length, 2);
  assert.doesNotMatch(html, /lovable|<script\b/i);
});

test('landing has a single heading, language, metadata, and local brand assets', () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="description"/);
  assert.match(html, /alt="Polaris"/);
  for (const asset of ['polaris-logo.png', 'plane.svg', 'landing-route.svg']) {
    assert.ok(fs.existsSync(path.join(root, asset)));
  }
});

test('simple cards contain the requested wording and no em dashes', () => {
  const cards = html.match(/<ol>[\s\S]*?<\/ol>/)[0];
  assert.doesNotMatch(cards, /—/);
  assert.match(cards, /Search for a flight or find one on the map\./);
  assert.match(cards, /Select it to watch the flight data\./);
});

test('legal footer links have real pages and explicit routes', () => {
  for (const name of ['privacy', 'terms', 'cookies']) {
    assert.match(html, new RegExp(`href="/${name}"`));
    assert.ok(config.rewrites.some(r => r.source === `/${name}` && r.destination === `/${name}.html`));
    const policy = fs.readFileSync(path.join(root, `${name}.html`), 'utf8');
    assert.match(policy, /Draft prepared October 4, 2026/);
    assert.equal((policy.match(/<h1\b/g) || []).length, 1);
  }
});

test('route geography and interpolation are consistent', () => {
  const { project, interpolate, LAX, DFW } = require('../tools/build-landing-route.cjs');
  for (const [t, expected] of [[0, LAX], [1, DFW]]) {
    const actual = interpolate(LAX, DFW, t);
    actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 1e-8));
  }
  for (const location of [LAX, DFW]) {
    const [x, y] = project(location);
    assert.ok(x > 0 && x < 800 && y > 0 && y + 30 < 340);
  }
  const svg = fs.readFileSync(path.join(root, 'landing-route.svg'), 'utf8');
  assert.match(svg, /This is not live flight data/);
  assert.doesNotMatch(svg, /Capa_1/);
});
