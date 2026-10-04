const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('every public page uses the same Polaris PNG favicon', () => {
  for (const page of ['index.html', 'tracker.html', 'privacy.html', 'terms.html', 'cookies.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const icons = html.match(/<link\b[^>]*rel="icon"[^>]*>/g) || [];
    assert.equal(icons.length, 1, page);
    assert.match(icons[0], /href="\/favicon.png"/, page);
    assert.match(icons[0], /type="image\/png"/, page);
  }
  const image = fs.readFileSync(path.join(root, 'favicon.png'));
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
