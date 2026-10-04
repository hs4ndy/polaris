const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'landing.html'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

test('landing and tracker have distinct routes, ahead of the existing fallback', () => {
  assert.deepEqual(config.rewrites[0], { source: '/', destination: '/landing.html' });
  assert.deepEqual(config.rewrites[1], { source: '/tracker', destination: '/index.html' });
  assert.ok(fs.existsSync(path.join(root, 'index.html')));
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
  for (const asset of ['polaris-logo.png', 'plane.svg']) {
    assert.ok(fs.existsSync(path.join(root, asset)));
  }
});
