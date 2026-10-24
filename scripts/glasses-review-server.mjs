// Local-only fixture harness. Real DCC routes; disposable PostgreSQL; no external integrations.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.env.NODE_ENV === 'production' || process.env.DCC_GLASSES_REVIEW !== '1' || !process.env.DCC_PGLITE_MODULE) throw new Error('Explicit glasses review and disposable PGlite runtime required');
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
const ctx = await require('./activity-review-backend')(app);
const date = ctx.getTodayStr(), owner = { userId: 1, workspaceId: 'ws-1' };
const hhmm = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
const now = new Date(), minute = now.getUTCHours() * 60 + now.getUTCMinutes();
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
const W = require('../public/js/workout-model'), record = W.empty(); record.plan = W.gentleReset(() => ctx.crypto.randomUUID());
const routine = await require('../activity-store').createActivityStore(ctx).create({ title: 'DEMO · Gentle Reset', date, record }, owner);
app.get('/api/me', (req, res) => req.session?.userId ? res.json({ userId: req.session.userId, workspaceId: req.workspaceId }) : res.status(401).json({ error: 'Review session expired' }));
app.get('/public/js/app-config.js', (_req, res) => res.type('js').send('window.DCC_APP_TIME_ZONE="UTC";'));
require('../routes/sync')(app, { ...ctx, resolveOwnerStrict: require('../middleware/resolve-owner').resolveOwnerStrict,
  buildDayResponse: async () => ({ date, schedule: { timeline: [] } }) });
app.get('/api/glasses-review-info', (_req, res) => res.json({ synthetic: true, storage: 'memory', date, routineId: routine.taskId }));
app.get('/glasses.html', (_req, res) => res.sendFile(path.join(root, 'glasses.html')));
app.get('/glasses-routine.html', (_req, res) => res.sendFile(path.join(root, 'glasses-routine.html')));
app.use('/public', express.static(path.join(root, 'public')));
app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
const server = app.listen(Number(process.env.PORT || 8396), '127.0.0.1', () => console.log('Synthetic glasses review: http://127.0.0.1:' + server.address().port + '/glasses.html'));
