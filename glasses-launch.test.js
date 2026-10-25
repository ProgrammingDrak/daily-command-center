const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const launch = require('./lib/glasses-launch');
const loginReturn = require('./public/js/login-return');
const source = fs.readFileSync(require.resolve('./server'), 'utf8');
const start = source.indexOf('    if (!req.session.userId) {');
const end = source.indexOf('\n    next();', start);
assert.ok(start > 0 && end > start);
const gate = vm.runInNewContext('(function(req,res,next){' + source.slice(start,end) + '\nnext();})', { loginReturn });

test('glasses launch uses actual auth gate and same-origin redirect, preserving explicit task links', async t => {
  const app = express();
  app.use((req,_res,next) => { req.session = req.headers['x-fixture-user'] ? {userId:1} : {}; next(); });
  app.use(gate);
  app.get(['/glasses','/glasses.html'], launch);
  app.get(['/glasses','/glasses.html'], (_req,res) => res.send('existing task detail'));
  app.get('/', (_req,res) => res.send('canonical full DCC'));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const url of ['/glasses','/glasses.html','/glasses.html?view=today','/glasses.html?view=unscheduled&date=2026-10-24','/glasses.html?tl=encoded&next=https%3A%2F%2Fevil.invalid','/glasses.html?task=']) {
    const unauth = await fetch(base+url,{redirect:'manual'});
    assert.equal(unauth.status,302);
    assert.equal(unauth.headers.get('location'),loginReturn.loginUrl(url));
    const response = await fetch(base+url,{headers:{'x-fixture-user':'yes'},redirect:'manual'});
    const target = '/' + (url.includes('?') ? url.slice(url.indexOf('?')) : '');
    assert.equal(response.status,302);
    assert.equal(response.headers.get('location'),target);
    assert.equal(new URL(target,base).origin,base);
    assert.equal(response.headers.get('cache-control'),'no-store');
    const full = await fetch(base+target,{headers:{'x-fixture-user':'yes'}});
    assert.equal(await full.text(),'canonical full DCC');
  }
  const deep = '/glasses.html?task=fixture-one&date=2026-10-24&view=tasks';
  const denied = await fetch(base+deep,{redirect:'manual'});
  assert.equal(denied.headers.get('location'),loginReturn.loginUrl(deep));
  const detail = await fetch(base+deep,{headers:{'x-fixture-user':'yes'},redirect:'manual'});
  assert.equal(detail.status,200);
  assert.equal(await detail.text(),'existing task detail');
  const head = await fetch(base+'/glasses.html',{method:'HEAD',headers:{'x-fixture-user':'yes'},redirect:'manual'});
  assert.equal(head.status,302);
  assert.equal(head.headers.get('location'),'/');
});

test('launch route remains behind production auth and account binding and before static files', () => {
  const route = source.indexOf('app.get(["/glasses", "/glasses.html"], require("./lib/glasses-launch"))');
  assert.ok(route > source.indexOf('app.use(require("./lib/account-binding"))'));
  assert.ok(route > end);
  assert.ok(route < source.indexOf('app.use(express.static(PROJECT_DIR'));
});
