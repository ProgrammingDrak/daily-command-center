const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const glassesShell = require('./lib/glasses-shell');

test('glasses shell precedes static HTML for both entry paths and keeps desktop unchanged', async t => {
  const app = express();
  app.get(['/', '/index.html'], glassesShell(__dirname));
  app.use(express.static(__dirname));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const original = fs.readFileSync('index.html', 'utf8');
  for (const path of ['/', '/index.html']) {
    assert.equal(await fetch(base + path).then(r => r.text()), original);
    const response = await fetch(base + path + '?device=glasses');
    const html = await response.text();
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.ok(html.indexOf('class="glasses-starting"') < html.indexOf('<body>'));
    assert.ok(html.indexOf('id="glasses-startup"') < html.indexOf('id="prep-float"'));
    assert.equal([...html.matchAll(/<script(?: defer)? src="([^"]+)"/g)].length, [...original.matchAll(/<script src="([^"]+)"/g)].length);
    assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]), [...original.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]));
  }
});

test('glasses shell is served after authentication and before the static index', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const route = server.indexOf('app.get(["/", "/index.html"], require("./lib/glasses-shell")(PROJECT_DIR))');
  assert.ok(route > server.indexOf('app.use(require("./lib/account-binding"))'));
  assert.ok(route < server.indexOf('app.use(express.static(PROJECT_DIR'));
});
