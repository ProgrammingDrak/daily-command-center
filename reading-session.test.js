const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReadingSession, readingTaskId, saveReadingSession } = require('./lib/reading-session');
const seed = { title: 'Between Two Fires', author: 'Christopher Buehlman', minutes: 30, url: 'http://127.0.0.1:4191/audiobookshelf/reading?book=book-one', requestId: 'request-one' };
test('validates duration and accepts private book links without fetching them', () => {
  assert.equal(normalizeReadingSession(seed).minutes, 30);
  assert.equal(normalizeReadingSession({ ...seed, title: '', url: '' }).url, '');
  for (const minutes of [0, 241, 2.5, 'bad']) assert.throws(() => normalizeReadingSession({ ...seed, minutes }), { status: 400 });
  for (const url of ['javascript:alert(1)', 'https://u:p@host/audiobookshelf/reading?book=book-one', 'https://host/path', seed.url + '&token=secret']) assert.throws(() => normalizeReadingSession({ ...seed, url }), { status: 400 });
});
test('idempotency is bound to both user and workspace', () => {
  const a = { userId: 1, workspaceId: 'one' };
  assert.equal(readingTaskId(a, seed.requestId), readingTaskId(a, seed.requestId));
  assert.notEqual(readingTaskId(a, seed.requestId), readingTaskId({ ...a, userId: 2 }, seed.requestId));
  assert.notEqual(readingTaskId(a, seed.requestId), readingTaskId({ ...a, workspaceId: 'two' }, seed.requestId));
});
test('same request creates one unscheduled task; retries never revive removed tasks', async () => {
  const rows = new Map(), queries = [], owner = { userId: 1, workspaceId: 'one' };
  const client = { query: async sql => { queries.push(sql); }, release() {} };
  const blockDB = { getBlockIncludingDeleted: async id => rows.get(id), createBlock: async row => { rows.set(row.id, row); return row; } };
  const pool = { connect: async () => client };
  const store = require('./project-store').createProjectStore({ pool, blockDB });
  const ctx = { pool, blockDB, store };
  const a = await saveReadingSession(ctx, seed, owner); const b = await saveReadingSession(ctx, seed, owner);
  assert.equal(rows.size, 1); assert.equal(b.duplicate, true); assert.equal(a.task.date, null); assert.equal(a.task.properties.kind, 'backlog'); assert.equal(a.task.properties.duration, 30); assert.equal(a.task.properties.readingSession.url, seed.url);
  a.task.deleted_at = 'now'; await assert.rejects(saveReadingSession(ctx, seed, owner), { status: 409 });
  assert.equal(rows.size, 1); assert.ok(queries.includes('ROLLBACK'));
});
