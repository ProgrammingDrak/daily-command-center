// Local-only synthetic QA harness. Never uses application tables or real account sessions.
const express = require('express');
const path = require('node:path');
const { Pool } = require('pg');
const { requireAdmin } = require('../lib/admin-access')(new Set(['drake']));
const root = path.resolve(__dirname, '..');
const databaseUrl = process.env.DCC_FEEDBACK_QA_DATABASE_URL || process.env.DATABASE_URL;
if (process.env.NODE_ENV === 'production' || !databaseUrl || !['localhost','127.0.0.1','[::1]'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Feedback QA requires a local Postgres URL and a non-production environment');
}
const schema = `dcc_feedback_review_${process.pid}_${Date.now()}`;
const setup = new Pool({ connectionString: databaseUrl });
let pool;
let server;
let failure = '';
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  if (server) await new Promise(resolve => server.close(resolve));
  if (pool) await pool.end();
  await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await setup.end();
}
async function main() {
  await setup.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  await pool.query('CREATE TABLE users (id integer PRIMARY KEY, username text, display_name text)');
  await pool.query('CREATE TABLE workspaces (id text PRIMARY KEY)');
  await pool.query("INSERT INTO users VALUES (1,'drake','Synthetic Admin'),(2,'member','Synthetic Member')");
  await pool.query("INSERT INTO workspaces VALUES ('ws-1'),('ws-2')");
  // Execute the production feedback table initializer against ONLY this isolated schema.
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const tableSource = source.slice(source.indexOf('async function ensureFeedbackTable()'), source.indexOf('async function ensureLoginEventsTable()'));
  const ctx = vm.createContext({ pool });
  vm.runInContext(tableSource, ctx);
  await ctx.ensureFeedbackTable();
  for (let i = 0; i < 55; i++) {
    await pool.query(`INSERT INTO feedback_messages (workspace_id,user_id,message,page_path,created_at,resolved_at)
      VALUES ('ws-2',$1,$2,$3,'2026-10-12T12:00:00.123456Z',$4)`,
    [i === 0 ? null : 2, i === 54 ? 'Synthetic long feedback\nSecond paragraph: ' + 'Readable text & <literal markup>. '.repeat(75) : `Synthetic feedback ${i + 1}`, i === 0 ? null : '/?tab=schedule', i === 1 ? '2026-10-13T12:00:00Z' : null]);
  }
  const app = express();
  app.use(express.json());
  app.get('/qa/session/:user', (req,res) => {
    const user = req.params.user === 'admin' ? 'drake' : req.params.user === 'member' ? 'member' : '';
    res.cookie('fixture_user',user,{sameSite:'lax'});
    res.redirect(user === 'drake' ? '/admin' : '/qa/submit');
  });
  app.post('/qa/failure/:kind', (req,res) => { failure = req.params.kind; res.json({ok:true}); });
  app.use((req,res,next) => {
    const user = String(req.headers.cookie || '').match(/(?:^|;\s*)fixture_user=(drake|member)/)?.[1];
    req.session = user ? { username:user, userId:user === 'drake' ? 1 : 2 } : {};
    req.workspaceId = user === 'drake' ? 'ws-1' : 'ws-2';
    if (req.path.startsWith('/public/')) return next();
    if (!user) return res.status(401).send('Synthetic QA session required: /qa/session/admin or /qa/session/member');
    next();
  });
  require('../routes/feedback')(app,{ requireAdmin, ensureFeedbackTable:ctx.ensureFeedbackTable, pool:{query(sql,args){
    if (failure === 'empty' && sql.includes('SELECT')) return Promise.resolve({rows: sql.startsWith('SELECT COUNT') ? [{total:0,latest_at:null}] : []});
    if ((failure === 'read' && sql.includes('SELECT')) || (failure === 'save' && sql.startsWith('INSERT'))) throw new Error('Synthetic storage failure');
    return pool.query(sql,args);
  }} });
  app.get('/api/admin/activity',requireAdmin,(_req,res) => {
    if (failure === 'activity') return res.status(500).json({error:'Synthetic login failure'});
    res.json({activity:[],summary:{latestActivityAt:null}});
  });
  app.get('/api/me',(req,res) => res.json({isAdmin:req.session.username === 'drake'}));
  app.get(['/admin','/admin.html'],requireAdmin,(_req,res) => res.sendFile(path.join(root,'admin.html')));
  app.get('/qa/submit',(_req,res) => res.type('html').send(`<!doctype html><html><head><title>Synthetic feedback QA</title></head><body>
    <h1>Synthetic feedback submission</h1><p>Isolated local fixture data only.</p>
    <button onclick="dccOpenFeedback()">Send feedback</button>
    <div id="feedback-panel"><textarea id="feedback-message" maxlength="4000" aria-label="Feedback message"></textarea>
    <button id="feedback-submit">Send</button><button id="feedback-close">Close</button><span id="feedback-status" role="status"></span></div>
    <script src="/public/js/feedback.js"></script></body></html>`));
  app.use('/public',express.static(path.join(root,'public')));
  server = app.listen(Number(process.env.DCC_FEEDBACK_QA_PORT || 8117),'127.0.0.1',() => console.log('Synthetic feedback QA: http://127.0.0.1:' + server.address().port + '/qa/session/admin'));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => close().then(() => process.exit(0)));
}
main().catch(async err => { console.error(err.message); await close(); process.exitCode=1; });
