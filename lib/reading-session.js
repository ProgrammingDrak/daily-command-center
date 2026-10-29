'use strict';
const { createHash } = require('node:crypto');
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function safeBookUrl(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw invalid('Enter a valid QuietShelf book link.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.pathname !== '/audiobookshelf/reading' || [...url.searchParams.keys()].some(key => key !== 'book') || !/^[a-zA-Z0-9_-]{8,100}$/.test(url.searchParams.get('book') || '')) throw invalid('Use a QuietShelf reading-shelf book link without credentials.');
  return url.href;
}
function normalizeReadingSession(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const author = typeof body.author === 'string' ? body.author.trim() : '';
  const minutes = Number(body.minutes);
  if (title.length > 300 || author.length > 200 || !Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw invalid('Choose a reading duration from 1 to 240 minutes.');
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId)) throw invalid('Invalid reading session request.');
  return { title, author, minutes, url: safeBookUrl(body.url), requestId: body.requestId };
}
function readingTaskId(owner, requestId) {
  const h = createHash('sha256').update(JSON.stringify([owner.workspaceId, owner.userId, requestId])).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
async function saveReadingSession({ pool, blockDB, store }, input, owner) {
  const reading = normalizeReadingSession(input);
  const id = readingTaskId(owner, reading.requestId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['reading:' + id]);
    const existing = await blockDB.getBlockIncludingDeleted(id, client);
    if (existing) {
      if (existing.user_id !== owner.userId || existing.workspace_id !== owner.workspaceId) throw Object.assign(new Error('Reading session unavailable'), { status: 409 });
      if (existing.deleted_at) throw Object.assign(new Error('This session was removed. Start a new reading session to add another.'), { status: 409 });
      await client.query('COMMIT'); return { task: existing, duplicate: true };
    }
    const task = await store.createTask({ id, title: `Read for ${reading.minutes} minutes${reading.title ? ': ' + reading.title : ''}`, duration: reading.minutes, kind: 'backlog', source: 'quietshelf-reading', detail: [reading.title && `${reading.title}${reading.author ? ' by ' + reading.author : ''}`, reading.url && `Open book: ${reading.url}`, 'One intentional reading session. Schedule or start it when ready; completing this task does not mark the book finished.'].filter(Boolean).join('\n'), readingSession: reading }, owner, client);
    await client.query('COMMIT'); return { task, duplicate: false };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
module.exports = { safeBookUrl, normalizeReadingSession, readingTaskId, saveReadingSession };
