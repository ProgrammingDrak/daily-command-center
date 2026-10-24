// Local-only fixture harness. Real DCC routes; disposable PostgreSQL; no external integrations.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.env.NODE_ENV === 'production' || process.env.DCC_GLASSES_REVIEW !== '1' || (!process.env.DCC_PGLITE_MODULE && !process.env.DCC_TEST_DATABASE_URL)) throw new Error('Explicit glasses review and disposable database runtime required');
process.env.DCC_ACTIVITY_REVIEW = '1';
const app = express(), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'");
  const mode = /dcc-review-auth=(none|other)/.exec(req.headers.cookie || '')?.[1];
  if (mode) req.headers['x-review-session'] = mode;
  next();
});
const ctx = await require('./activity-review-backend')(app, { enforceAccountBinding: true });
const date = ctx.getTodayStr(), owner = { userId: 1, workspaceId: 'ws-1' };
const hhmm = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
// Pair this fixture clock with Playwright's fixed Date clock, even across midnight.
const fixtureNow = date + 'T12:00:00.000Z', minute = 12 * 60;
const currentStart = Math.max(0, minute - 15), nextStart = Math.min(1400, minute + 30);
async function task(id, title, properties, taskDate = date) {
  return ctx.blockDB.createItineraryTask({ id, date: taskDate, ...owner, properties: { local_id: id, kind: 'manual_task', type: 'task', title, status: 'open', publicVisibility: 'private', duration: 30, ...properties } });
}
await task('glasses-now', 'Prepare the weekly plan', { start: hhmm(currentStart), end: hhmm(Math.min(1439, minute + 20)), detail: 'Review the three priorities. Choose one concrete next action for each. Keep this focused on the work you can finish today.' });
await task('glasses-next', 'Team check-in', { start: hhmm(nextStart), end: hhmm(Math.min(1439, nextStart + 30)), type: 'meeting', detail: 'Bring the updated plan and the two open questions.' });
await task('glasses-unplanned', 'Send the follow-up notes', { start: null, end: null, detail: 'Summarize decisions and owners. This is synthetic local test data.' });
await task('glasses-backlog', 'Book a rehearsal room', { kind: 'backlog', stage: 'Whenever', start: null, end: null }, null);
await task('glasses-no-alias', 'Alias-less backlog fixture', { local_id: null, kind: 'backlog', stage: 'Whenever', start: null, end: null }, null);
await task('glasses-long', 'A long task title to verify wrapping and readable focus at compact display sizes', { start: null, detail: 'Long task details. '.repeat(80) });
await task('glasses-done', 'Finished morning task', { start: '08:00', end: '08:30', done: true, status: 'done', completedAt: date + 'T08:30:00Z' });
await task('glasses-child-done', 'Completed planning step', { start: null, end: null, subtaskOf: 'glasses-now', done: true, status: 'done', completedAt: date + 'T11:50:00Z' });
await task('glasses-child-open', 'Remaining planning step', { start: null, end: null, subtaskOf: 'glasses-now' });
await task('glasses-triage', 'Review a source message', { start: null, end: null, triageBlock: true, triageId: 'source-1' });
await task('glasses-done-untimed', 'Finished unscheduled work', { start: null, end: null, done: true, status: 'done', completedAt: date + 'T11:40:00Z' });
const yesterday = new Date(date + 'T12:00:00Z'); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
await task('glasses-earlier', 'Yesterday still needs attention', { start: '10:00', end: '10:30' }, yesterday.toISOString().slice(0,10));
await ctx.blockDB.createBlock({ id: 'glasses-waiting', type: 'block', date: null, user_id: owner.userId, workspace_id: owner.workspaceId, properties: { kind: 'delegated_item', title: 'A decision from Alex', myTask: 'Confirm the delivery plan', delegatee: {name:'Alex'}, checkInDate: yesterday.toISOString().slice(0,10), status: 'open' } });
const W = require('../public/js/workout-model'), record = W.empty(); record.plan = W.gentleReset(() => ctx.crypto.randomUUID());
const routine = await require('../activity-store').createActivityStore(ctx).create({ title: 'DEMO · Gentle Reset', date, record }, owner);
app.get('/api/me', (req, res) => req.session?.userId ? res.json({ userId: req.session.userId, workspaceId: req.workspaceId }) : res.status(401).json({ error: 'Review session expired' }));
app.get('/public/js/app-config.js', (req, res) => res.type('js').send('window.DCC_APP_TIME_ZONE="UTC";window.DCC_ACCOUNT_CONTEXT=' + JSON.stringify(req.session?.userId ? { userId: req.session.userId, workspaceId: req.workspaceId } : null) + ';'));
require('../routes/sync')(app, { ...ctx, resolveOwnerStrict: require('../middleware/resolve-owner').resolveOwnerStrict,
  buildDayResponse: async (_date, userId) => ({ date, triage: { open_items: userId === 1 ? [{id:'unprepared-source',title:'Incoming source review',summary:'This source has not been materialized as a task yet.'}] : [], suppressed_items: [] }, schedule: { timeline: [], timeBlocks: [{id:'morning',name:'Morning',start:'06:00',end:'12:00',activeDays:['mon','tue','wed','thu','fri','sat','sun']},{id:'afternoon',name:'Afternoon',start:'12:00',end:'18:00',activeDays:['mon','tue','wed','thu','fri','sat','sun']}] } }) });
app.get('/api/glasses-review-info', (_req, res) => res.json({ synthetic: true, storage: process.env.DCC_PGLITE_MODULE ? 'memory' : 'isolated-schema', accountBinding: true, date, now: fixtureNow, routineId: routine.taskId }));
app.get('/glasses.html', (_req, res) => res.sendFile(path.join(root, 'glasses.html')));
app.get('/glasses-routine.html', (_req, res) => res.sendFile(path.join(root, 'glasses-routine.html')));
app.use('/public', express.static(path.join(root, 'public')));
app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
const server = app.listen(Number(process.env.PORT || 8396), '127.0.0.1', () => console.log('Synthetic glasses review: http://127.0.0.1:' + server.address().port + '/glasses.html'));
