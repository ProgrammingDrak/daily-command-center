// SPDX-License-Identifier: AGPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const {sourceOffer} = require('./source-offer.js');
const vm = require('node:vm');
const options = {repository: 'daily-command-center', isPublic: true};
const revision = 'a'.repeat(40);

test('public source offer and Railway fallback bind the full revision', () => {
  for (const env of [{SOURCE_REVISION: revision}, {RAILWAY_GIT_COMMIT_SHA: revision}]) {
    const html = sourceOffer(options, {...env, NODE_ENV: 'production'});
    assert.ok(html.includes(`https://github.com/ProgrammingDrak/daily-command-center/archive/${revision}.tar.gz`));
    assert.ok(html.includes(`<code>${revision}</code>`));
  }
});

test('local preview truthfully reports missing source access', () => {
  assert.match(sourceOffer(options, {}), /Source access for this local preview is not configured/);
});

test('production rejects absent, malformed and mismatched source metadata', () => {
  for (const env of [
    {}, {SOURCE_REVISION: 'short'}, {SOURCE_REVISION: 'g'.repeat(40)},
    {SOURCE_REVISION: revision, SOURCE_ARCHIVE_URL: `https://example.com/${'b'.repeat(40)}.tar.gz`},
    {SOURCE_REVISION: revision, SOURCE_ARCHIVE_URL: `http://example.com/${revision}.tar.gz`},
    {SOURCE_REVISION: revision, SOURCE_ARCHIVE_URL: `https://user:password@example.com/${revision}.tar.gz`},
    {SOURCE_REVISION: revision, SOURCE_ARCHIVE_URL: `https://example.com/${revision}.tar.gz?token=example`},
    {SOURCE_REVISION: revision, SOURCE_ARCHIVE_URL: `https://example.com/${revision}.tar.gz#fragment`},
  ]) assert.throws(() => sourceOffer(options, {...env, NODE_ENV: 'production'}), /Source publication gate/);
  assert.throws(() => sourceOffer({...options, isPublic: false}, {SOURCE_REVISION: revision, NODE_ENV: 'production'}), /Source publication gate/);
});

test('custom HTTPS source access is accepted and repository text is escaped', () => {
  const url = `https://example.com/releases/${revision}/source.zip`;
  const html = sourceOffer({repository: '<script>example</script>', isPublic: false}, {NODE_ENV: 'production', SOURCE_REVISION: revision, SOURCE_ARCHIVE_URL: url});
  assert.ok(html.includes(url));
  assert.ok(html.includes('&lt;script&gt;example&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
});

test('real HTTP source and license routes precede rejecting authentication', async () => {
  const saved = Object.fromEntries(['NODE_ENV', 'SOURCE_REVISION', 'RAILWAY_GIT_COMMIT_SHA', 'SOURCE_ARCHIVE_URL'].map(key => [key, process.env[key]]));
  let server;
  try {
    process.env.NODE_ENV = 'production';
    process.env.SOURCE_REVISION = revision;
    delete process.env.SOURCE_ARCHIVE_URL;
    const app = express();
    const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const registration = serverSource.match(/^require\('\.\/source-offer\.js'\)\.registerSourceOffer\(app, .*\);$/m);
    assert.ok(registration, 'production must register source access');
    assert.ok(registration.index < serverSource.indexOf('app.use('), 'source routes must precede all production middleware, including authentication');
    vm.runInNewContext(registration[0], { app, require });
    app.use((_req, res) => res.status(403).send('sign in'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const source = await fetch(base + '/source');
    assert.equal(source.status, 200);
    assert.equal(source.headers.get('cache-control'), 'no-store');
    assert.ok((await source.text()).includes(revision));
    const license = await fetch(base + '/license');
    assert.equal(license.status, 200);
    assert.equal(await license.text(), fs.readFileSync(path.join(__dirname, 'LICENSE'), 'utf8'));
    assert.equal((await fetch(base + '/protected')).status, 403);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
