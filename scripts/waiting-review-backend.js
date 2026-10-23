// Explicit in-memory fixtures only; never mounted by the production server.
module.exports = async function mountWaitingReview(app) {
  if (process.env.DCC_WAITING_REVIEW !== '1' || !process.env.DCC_PGLITE_MODULE) throw new Error('Waiting review requires an explicit in-memory database runtime');
  const ctx = await require('../test-support/activity-db').createActivityDb();
  const { route, isValidDate } = require('../lib/route-helpers');
  const date = new Date().toISOString().slice(0, 10);
  Object.assign(ctx, { route, APP_TIME_ZONE: 'UTC', getTodayStr: () => date, getScheduleBlocks: async () => [], filterLegacyGcalBlocks: rows => rows, isValidDate, broadcast() {} });
  app.use((req, _res, next) => { req.session = { userId: 1 }; req.workspaceId = 'ws-1'; next(); });
  app.get('/public/js/app-config.js', (_req, res) => res.type('js').send('window.DCC_APP_TIME_ZONE="UTC";window.DCC_DELTA_SYNC_ENABLED=false;window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:"ws-1"};'));
  let ids, failCleanup = false;
  const clusterTasks = ctx.blockDB.getWaitingClusterTasks;
  ctx.blockDB.getWaitingClusterTasks = async (...args) => {
    if (failCleanup) { failCleanup = false; throw new Error('Synthetic cleanup interruption'); }
    return clusterTasks(...args);
  };
  app.post('/api/review/waiting/fail-cleanup', (_req, res) => { failCleanup = true; res.json({ ok: true }); });
  async function reset(req) {
    await ctx.pool.query('TRUNCATE blocks CASCADE');
    const task = properties => ctx.blockDB.createItineraryTask({ date, userId: 1, workspaceId: 'ws-1', properties: { kind: 'task', type: 'task', duration: 15, ...properties } });
    const work = await task({ title: 'DEMO · Finish supplier estimate', untimed: true });
    const item = await ctx.blockDB.createBlock({ type: 'block', date: null, user_id: 1, workspace_id: 'ws-1', properties: {
      kind: 'delegated_item', myTask: 'DEMO · Finish supplier estimate', title: 'Supplier reply', delegatee: { name: 'Example supplier' }, status: 'open', linkedBlockId: work.id, checkInDate: date, checkInDays: 7,
    } });
    if (req?.body?.followUpComplete) await ctx.blockDB.updateBlock(item.id, {properties: {...item.properties, checkInRepeat:false, checkInDate:null, checkInTaskId:null, checkInHistory:[{completedAt:date+'T08:00:00Z',note:'Previous follow-up'}]}});
    const reminder = await task({ title: 'DEMO · Check in with supplier', source: 'waiting-checkin', delegatedItemId: item.id, local_id: `waiting-checkin-task:${item.id}:0`, start: '10:00', end: '10:15' });
    const nextReminder = await task({ title: 'DEMO · Another pending check-in', source: 'waiting-checkin', delegatedItemId: item.id, local_id: `waiting-checkin-task:${item.id}:1`, start: '11:00', end: '11:15' });
    if (req?.body?.followUpComplete) {
      await ctx.blockDB.updateBlock(reminder.id, {properties: {...reminder.properties, completed:true, completedAt:date+'T08:00:00Z'}});
      await ctx.blockDB.deleteBlock(nextReminder.id);
    }
    if (req?.body?.unlinked) {
      const latest = await ctx.blockDB.getBlock(item.id);
      await ctx.blockDB.updateBlock(item.id, {properties: {...latest.properties, linkedBlockId:null}});
    }
    if (req?.body?.existing) await ctx.blockDB.updateBlock(item.id, {properties: {...item.properties, checkInTaskId:reminder.id,checkInScheduledFor:date}});
    ids = { work: work.id, item: item.id, reminder: reminder.id, nextReminder: nextReminder.id, date };
    return ids;
  }
  app.post('/api/review/waiting/reset', route(reset));
  app.get('/api/review/waiting/state', route(async () => ({ ids, allRows:(await ctx.pool.query('SELECT * FROM blocks WHERE deleted_at IS NULL')).rows, rows: await Promise.all([ids.work, ids.item, ids.reminder, ids.nextReminder].map(id => ctx.blockDB.getBlock(id))) })));
  require('../routes/blocks')(app, ctx);
  await reset();
  const cleanup = async () => { await ctx.close(); process.exit(0); };
  process.once('SIGTERM', cleanup); process.once('SIGINT', cleanup);
  console.log('Waiting review: synthetic in-memory fixtures and production completion routes only.');
};
