// Real routes and PostgreSQL, synthetic accounts only. Never reads .env.
const express = require('express');
const path = require('node:path');
async function createSharedQueueFixture() {
  const ctx = await require('./activity-db').createActivityDb();
  await ctx.pool.query(require('../conversation-store').FOREGROUND_INDEX_SQL);
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const id = Number(req.get('X-Review-User'));
    if ([1, 3].includes(id)) req.session = { userId: id, username: id === 1 ? 'Alex' : 'Blair' };
    req.workspaceId = 'ws-1'; req.sessionID = 'synthetic-viewer';
    if (req.path.startsWith('/api/') && !req.path.startsWith('/api/public/') && !req.session) return res.status(401).json({ error: 'Sign in' });
    next();
  });
  const publicSse = require('../lib/public-sse').createPublicSseHub({ debounceMs: 50 });
  // Today in the fixture's UTC app zone, so "Done today" and "Later today" use the real clock.
  const date = new Date().toISOString().slice(0, 10);
  let day = { schedule: { timeline: [] }, triage: { open_items: [] } };
  Object.assign(ctx, {
    APP_TIME_ZONE: 'UTC', getTodayStr: () => date, isValidDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value || ''),
    coerceDateString: value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10),
    buildDayResponse: async () => day, filterLegacyGcalBlocks: rows => rows,
    capabilities: require('../capabilities'), route: require('../lib/route-helpers').route,
    slotStore: require('../slot-store'), scoreTaskPoints: require('../slot-scoring').scoreTaskPoints,
    getRequestOrigin: () => 'synthetic-local',
    // Real shared-link stream with a short debounce, so browser QA sees live pings.
    broadcast(type, _data, workspaceId) {
      if (workspaceId && ['blocks-changed', 'dcc-state-changed', 'todo-share-changed', 'slot-changed'].includes(type)) publicSse.ping(workspaceId);
    },
    registerPublicSse: (ws, req, res) => publicSse.register(ws, req, res), closePublicSse: ws => publicSse.close(ws)
  });
  require('../routes/social-todo')(app, ctx);
  require('../routes/working-queue')(app, ctx, { enabled: true });
  app.use('/public', express.static(path.join(__dirname, '../public')));
  app.get('/todo/:token', (_req, res) => res.sendFile(path.join(__dirname, '../public-todo.html')));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(url, { user, body, method = body ? 'POST' : 'GET' } = {}) {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'X-Review-User': String(user) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const share = (await request('/api/todo-share', { user: 1, body: {} })).body.share;
  const url = '/api/public/todo-share/' + share.token;
  const entries = [
    ['focus', 'Draft the launch story', 'foreground'], ['review', 'Review the welcome screens', 'background'],
    ['low', 'Explore the next idea', 'queued'], ['high', 'Prepare the release checklist', 'queued'],
    ['background', 'Run the accessibility checks', 'background'], ['paused', 'Polish the help page', 'paused'],
    ['blocked', 'Wait for the illustration', 'blocked'], ['done', 'Sketch the new navigation', 'completed'],
    ['private', 'PRIVATE TASK SENTINEL', 'background'], ['older', 'OUTSIDE DAY SENTINEL', 'background'],
    ['backlog', 'BACKLOG SENTINEL', 'queued'], ['guided', 'GUIDED SENTINEL', 'background'],
    ['unselected', 'NOT QUEUED SENTINEL', null]
  ];
  const items = {}, order = [];
  for (const [id, title, status] of entries) {
    await ctx.blockDB.createBlock({ id, type: 'block', user_id: 1, workspace_id: 'ws-1', date: id === 'older' ? new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10) : date,
      properties: { title, kind: id === 'backlog' ? 'backlog' : 'task', type: id === 'guided' ? 'guided' : 'task',
        local_id: 'local-' + id, publicVisibility: id === 'private' ? 'private' : 'public',
        taskPriority: id === 'high' ? 'High' : id === 'low' ? 'Low' : 'Medium',
        ...(status === 'foreground' ? { startedAt: date + 'T00:00:00.000Z' } : {}),
        ...(status === 'completed' ? { doneAt: date + 'T00:00:00.000Z' } : {}) } });
    if (status) { order.push(id); items[id] = { status, hasActivity: !['queued'].includes(status), note: 'PRIVATE QUEUE NOTE SENTINEL' }; }
  }
  await ctx.pool.query('INSERT INTO work_rotations(workspace_id,user_id,state) VALUES($1,$2,$3)', ['ws-1', 1, { version: 2, order, items }]);
  await ctx.pool.query("INSERT INTO delegated_work(user_id,workspace_id,task_id,work_key,report) VALUES(1,'ws-1','review','demo',$1)", [{ phase: 'needs-review', reviewActions: ['Review the draft'], at: '2026-10-29T10:01:00Z', summary: 'PRIVATE ASSISTANT REPORT SENTINEL' }]);
  return { ...ctx, base, date, url, token: share.token, request, setDay(value) { day = value; },
    async close() { await new Promise(resolve => server.close(resolve)); await ctx.close(); } };
}
module.exports = { createSharedQueueFixture };
