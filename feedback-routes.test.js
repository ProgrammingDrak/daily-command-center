const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { isAdminSession, requireAdmin } = require('./lib/admin-access')(new Set(['drake']));

function harness() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const username = req.headers['x-fixture-user'];
    req.session = username ? { userId: username === 'drake' ? 1 : 2, username, role: 'owner' } : {};
    req.workspaceId = `ws-${req.session.userId}`;
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    next();
  });
  const rows = [];
  let fail = false;
  let queryCount = 0;
  const pool = { query: async (sql, params) => {
    queryCount++;
    if (fail) throw new Error('private database password detail');
    if (sql.startsWith('INSERT')) {
      const row = { id: rows.length + 1, workspace_id: params[0], user_id: params[1], message: params[2], page_path: params[3], created_at: '2026-10-13T12:00:00.000000Z', cursor_time: '2026-10-13T12:00:00.000000Z', username: 'member', display_name: 'Synthetic Member' };
      rows.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ total: rows.length, latest_at: rows[0]?.created_at }] };
    assert.match(sql, /LEFT JOIN users u ON u.id = f.user_id/);
    assert.match(sql, /ORDER BY f.created_at DESC, f.id DESC/);
    const items = [...rows].sort((a,b) => b.id - a.id).filter(r => !params[2] || r.id < Number(params[2]));
    return { rows: items.slice(0, params[0]) };
  } };
  require('./routes/feedback')(app, { pool, requireAdmin, ensureFeedbackTable: async () => {} });
  // Exercise the exact admin/static registration from the production server.
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf('app.get(["/admin", "/admin.html"]');
  assert.ok(start >= 0, 'both admin paths must be registered before static serving');
  const end = source.indexOf('// ── Startup', start);
  vm.runInNewContext(source.slice(start, end), { app, requireAdmin, path, PROJECT_DIR: __dirname, express });
  return { app, rows, setFailure(value) { fail = value; }, queries() { return queryCount; } };
}
async function request(app, url, { user = 'drake', method = 'GET', body } = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method,
      headers: { ...(user ? { 'x-fixture-user': user } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null, cache: res.headers.get('cache-control') };
  } finally { await new Promise(resolve => server.close(resolve)); }
}
test('existing username allowlist grants site-admin access; workspace roles do not', () => {
  assert.equal(isAdminSession({ session: { username: 'DRAKE', userId: 1 } }), true);
  assert.equal(isAdminSession({ session: { username: 'member', userId: 2, role: 'admin', isAdmin: true } }), false);
  assert.equal(isAdminSession({ session: {} }), false);
});
test('ordinary and anonymous users cannot read inbox or either admin page path', async () => {
  const h = harness();
  for (const url of ['/api/admin/feedback', '/admin', '/admin.html']) {
    assert.equal((await request(h.app, url, { user: 'member' })).status, 403, url);
    assert.equal((await request(h.app, url, { user: null })).status, 401, url);
  }
  assert.equal(h.queries(), 0);
  const admin = await request(h.app, '/admin');
  assert.equal(admin.status, 200);
  assert.equal(admin.cache, 'no-store');
  assert.equal((await request(h.app, '/admin.html')).status, 200);
});
test('a member submission arrives intact in the admin inbox with author and context', async () => {
  const h = harness();
  const message = 'First line\nSecond line <script>literal text</script>';
  const sent = await request(h.app, '/api/feedback', { user: 'member', method: 'POST', body: { message, pagePath: '/?tab=schedule' } });
  assert.equal(sent.status, 201);
  assert.ok(sent.body.feedback.id);
  const inbox = await request(h.app, '/api/admin/feedback');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.cache, 'no-store');
  assert.equal(inbox.body.feedback[0].id, sent.body.feedback.id);
  assert.equal(inbox.body.feedback[0].message, message);
  assert.equal(inbox.body.feedback[0].display_name, 'Synthetic Member');
  assert.equal(inbox.body.feedback[0].page_path, '/?tab=schedule');
  assert.equal(inbox.body.summary.total, 1);
});
test('pagination preserves same-time submissions and rejects malformed cursors', async () => {
  const h = harness();
  for (const message of ['older','middle','newest']) await request(h.app, '/api/feedback', { user:'member', method:'POST', body:{message} });
  const first = await request(h.app, '/api/admin/feedback?limit=2');
  assert.deepEqual(first.body.feedback.map(r => r.message), ['newest','middle']);
  assert.ok(first.body.nextCursor);
  const second = await request(h.app, '/api/admin/feedback?limit=2&before=' + encodeURIComponent(first.body.nextCursor));
  assert.deepEqual(second.body.feedback.map(r => r.message), ['older']);
  assert.equal(second.body.nextCursor, null);
  assert.equal(second.body.summary.total, 3);
  assert.equal((await request(h.app, '/api/admin/feedback?before=bad')).status, 400);
});
test('invalid submissions do not write; storage/read errors are honest and contain no database details', async () => {
  const h = harness();
  for (const message of ['  ', 'x'.repeat(4001)]) assert.equal((await request(h.app, '/api/feedback', {user:'member',method:'POST',body:{message}})).status, 400);
  assert.equal(h.rows.length, 0);
  h.setFailure(true);
  const failed = await request(h.app, '/api/feedback', { user:'member', method:'POST', body:{message:'keep draft'} });
  assert.equal(failed.status, 500);
  assert.match(failed.body.error, /Could not save/);
  const read = await request(h.app, '/api/admin/feedback');
  assert.equal(read.status, 500);
  assert.doesNotMatch(read.text, /password detail/);
  h.setFailure(false);
  const empty = await request(h.app, '/api/admin/feedback');
  assert.deepEqual(empty.body.feedback, []);
  assert.equal(empty.body.summary.total, 0);
});
