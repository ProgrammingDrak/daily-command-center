const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const loginReturn = require('./public/js/login-return');
const source = fs.readFileSync(require.resolve('./server'), 'utf8');

test('login destinations preserve local page, query and fragment and default to home', () => {
  for (const value of [undefined, null, '', [], {}, 12]) assert.equal(loginReturn.normalize(value), '/');
  for (const value of ['/glasses.html', '/glasses.html?view=tasks&task=one#detail', '/glasses-routine.html?date=2026-10-24', '/?tab=schedule', '/todo/a%20b']) {
    assert.equal(loginReturn.normalize(value), value);
    assert.equal(new URL(loginReturn.loginUrl(value), 'https://dcc.invalid').searchParams.get('next'), value);
  }
  assert.equal(loginReturn.loginUrl('/'), '/login');
});

test('login destinations reject external, ambiguous, malformed and recursive paths', () => {
  const invalid = ['https://evil.example', 'javascript:alert(1)', '//evil.example', '///evil.example', '/\\evil.example', '/%5cevil.example', '/%2f%2fevil.example', '/.%2e//evil.example', '/\nevil.example', '/%0devil', '/bad%zz', ' /glasses.html', 'glasses.html', '/login?next=//evil.example', '/register', '/foo/../login', '/%6cogin', '/login.html'];
  for (const value of invalid) assert.equal(loginReturn.normalize(value), '/', value);
});

// Execute the actual server gate and auth-page handler without starting its
// production integrations or database. The source slices fail if wiring changes.
const gateStart = source.indexOf('    if (!req.session.userId) {');
const gateEnd = source.indexOf('\n    next();', gateStart);
assert.ok(gateStart > 0 && gateEnd > gateStart);
const pageStart = source.indexOf('function sendAuthPage(req, res) {');
const pageEnd = source.indexOf('\napp.get("/login"', pageStart);
assert.ok(pageStart > 0 && pageEnd > pageStart);
function execute(code, req) {
  const result = {};
  const res = { redirect: value => { result.redirect = value; }, status: value => { result.status = value; return res; }, json: value => { result.json = value; }, sendFile: value => { result.file = value; } };
  vm.runInNewContext(code, { req, res, loginReturn, path: require('node:path'), PROJECT_DIR: '/fixture' });
  return result;
}
const gate = req => execute('(function () {' + source.slice(gateStart, gateEnd) + '})();', { session: {}, method: 'GET', ...req });
const authPage = req => execute(source.slice(pageStart, pageEnd) + '\nsendAuthPage(req, res);', { session: {}, query: {}, ...req });

test('actual server gate retains glasses state and keeps API failures as 401', () => {
  const target = '/glasses.html?view=tasks&task=abc&page=2';
  assert.equal(gate({ path: '/glasses.html', originalUrl: target }).redirect, loginReturn.loginUrl(target));
  assert.equal(gate({ path: '/glasses.html', originalUrl: target, method: 'HEAD' }).redirect, loginReturn.loginUrl(target));
  assert.equal(gate({ path: '/', originalUrl: '/' }).redirect, '/login');
  assert.equal(gate({ path: '/glasses.html', originalUrl: target, method: 'POST' }).redirect, '/login');
  const api = gate({ path: '/api/me', originalUrl: '/api/me' });
  assert.equal(api.status, 401); assert.equal(api.redirect, undefined);
});

test('completed or interrupted login returns signed-in sessions safely without loops', () => {
  assert.equal(authPage({}).file, '/fixture/login.html');
  assert.equal(authPage({ session: { userId: 1 } }).redirect, '/');
  assert.equal(authPage({ session: { userId: 1 }, query: { next: '/glasses.html?task=abc', auth: 'verifying' } }).redirect, '/glasses.html?task=abc');
  for (const next of ['//evil.example', '/login', ['/glasses.html', '//evil.example']]) {
    assert.equal(authPage({ session: { userId: 1 }, query: { next } }).redirect, '/');
  }
});
